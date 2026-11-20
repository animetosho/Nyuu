"use strict";

var async = require('async');
var path = require('path');
var fs = require('fs');
var Uploader = require('./uploadmgr');
var StreamReader, FileReader;
var EventEmitter = require('events').EventEmitter;
var Nyutil;

// Body Std §4 (v1.2): the encryption password is always written into the NZB
// as <meta type="password">, so it must be representable in XML 1.0:
// #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF].
// Unpaired surrogates are not representable. Errors never echo the password.
function isXml10Representable(text) {
	for(var i = 0; i < text.length; i++) {
		var c = text.charCodeAt(i);
		if(c >= 0xD800 && c <= 0xDBFF) {
			var next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
			if(next < 0xDC00 || next > 0xDFFF) return false;
			i++; // valid surrogate pair = code point in [#x10000-#x10FFFF]
		} else if(c >= 0xDC00 && c <= 0xDFFF) {
			return false;
		} else if(!(c === 0x9 || c === 0xA || c === 0xD || (c >= 0x20 && c <= 0xD7FF) || (c >= 0xE000 && c <= 0xFFFD))) {
			return false;
		}
	}
	return true;
}

function checkEncryptionPassword(password) {
	var text = password;
	if(typeof password != 'string') {
		if(!Buffer.isBuffer(password) && !(password instanceof Uint8Array))
			throw new TypeError('Encryption password must be a string or byte buffer');
		try {
			// byte passwords must be strict UTF-8 before they can be checked as text.
			// TextDecoder strips a leading BOM (EF BB BF). That is harmless: U+FEFF is
			// inside [#xE000-#xFFFD], so it is representable and the check outcome is
			// unchanged; the BOM bytes still reach the KDF and the NZB meta unchanged.
			text = new TextDecoder('utf-8', {fatal: true}).decode(password);
		} catch(e) {
			throw new Error('Encryption password is not valid UTF-8');
		}
	}
	if(!isXml10Representable(text))
		throw new Error('Encryption password contains characters that cannot be represented in XML 1.0 (NZB metadata)');
}

function injectEncryptionMeta(metaData, encryptionPassword) {
	// the transport password meta is authoritative: when encryption is enabled,
	// metaData.password is set to the encryption password (Q-1: if an archive password was set, encryption password wins)
	// the true marker is authoritative when encryption is enabled: a
	// user-supplied false value would produce a contradictory NZB (downloaders
	// would treat ciphertext as ordinary yEnc), so it is always overridden
	metaData.yenc_encrypted = 'true';
	metaData.password = encryptionPassword;
	// Body Std §8 (v1.2): receivers MUST reject NZBs declaring unknown or
	// unsupported yenc_version or yenc_cipher. All optional yenc_version /
	// yenc_cipher metadata is omitted when encryption is enabled, rather than
	// writing values or overwriting with canonical values
	// (matches ngPost; keeps optional fields optional).
	delete metaData.yenc_version;
	delete metaData.yenc_cipher;
}

exports.log = null;
exports.setLogger = function(log) {
	exports.log = log;
	Uploader.setLogger(log);
};

// Wraps opts.nzb (factory or object form) so the emitted NZB carries the
// encryption meta; the caller's nzb/metaData objects are never mutated.
// Used both after key derivation and for a caller-supplied encryption
// context, whose key must never be re-derived.
function wrapNzbWithEncryptionMeta(opts) {
	var localOpts = Object.assign({}, opts);
	if(typeof localOpts.nzb == 'function') {
		var origNzb = localOpts.nzb;
		localOpts.nzb = function() {
			var res = origNzb.apply(this, arguments);
			if(res && Array.isArray(res) && res[1] && typeof res[1] == 'object') {
				var copy = res.slice();
				copy[1] = Object.assign({}, res[1]);
				copy[1].metaData = Object.assign({}, copy[1].metaData);
				injectEncryptionMeta(copy[1].metaData, localOpts.encryptionPassword);
				return copy;
			}
			return res;
		};
	} else if(localOpts.nzb && typeof localOpts.nzb == 'object') {
		localOpts.nzb = Object.assign({}, localOpts.nzb);
		localOpts.nzb.metaData = Object.assign({}, localOpts.nzb.metaData);
		injectEncryptionMeta(localOpts.nzb.metaData, localOpts.encryptionPassword);
	}
	localOpts._encryptionMetaWrapped = true;
	return localOpts;
}

exports.upload = function(_files, opts, cb) {
	if(opts.encryption) {
		// Caller-supplied context: articles are encrypted, so the NZB must
		// still carry the meta whenever the password is known. The supplied
		// key/salt are used as-is; nothing is re-derived here. The
		// _encryptionMetaWrapped marker (set only on the internal copy made
		// by the derivation branch below) prevents double-wrapping.
		if(opts.encryptionPassword && !opts._encryptionMetaWrapped) {
			try {
				checkEncryptionPassword(opts.encryptionPassword); // before any NNTP work
			} catch(e) {
				var deferredEnc = new EventEmitter();
				process.nextTick(cb.bind(null, e));
				return deferredEnc;
			}
			opts = wrapNzbWithEncryptionMeta(opts);
		}
	} else if(opts.encryptionEnabled === true) {
		var deferred = new EventEmitter();
		var cryptoUtil = require('./crypto');
		if(!opts.encryptionPassword) {
			process.nextTick(cb.bind(null, new Error('Encryption password is required')));
			return deferred;
		}
		try {
			checkEncryptionPassword(opts.encryptionPassword); // before key derivation or any NNTP work
		} catch(e) {
			process.nextTick(cb.bind(null, e));
			return deferred;
		}
		var salt = cryptoUtil.generateEncryptionSalt();
		cryptoUtil.deriveKey(opts.encryptionPassword, salt).then(function(key) {
			var localOpts = wrapNzbWithEncryptionMeta(opts);
			localOpts.encryption = { key: key, salt: salt };
			var actual = exports.upload(_files, localOpts, cb);
			['start', 'processing_file', 'read_complete'].forEach(function(event) {
				actual.on(event, function() { deferred.emit.apply(deferred, [event].concat(Array.prototype.slice.call(arguments))); });
			});
		}, cb);
		return deferred;
	}
	var files = {};
	var hasUnseekableFiles = false;
	var archiveAll = [];
	var ee = new EventEmitter();
	
	var processDirFile = function(stats, cb) {
		if(stats.isDirectory() && exports.log) {
			exports.log.warn('Skipping directory: ' + stats.file);
			return cb();
		}
		if(stats.isSymbolicLink()) return cb();
		if(!stats.isFile()) return cb(new Error('Unknown file type for file: ' + stats.file));
		if(!opts.processEmptyFiles && !stats.size && exports.log) {
			exports.log.warn('Skipping empty file: ' + stats.file);
			return cb();
		}
		// TODO: consider making the basename relative to root specified folder
		var nam = opts.fileNameTransform(stats.file);
		if(nam || nam === '')
			files[stats.file] = {size: stats.size, name: nam, stat: stats};
		cb();
	};
	
	var stat = opts.skipSymlinks ? fs.lstat : fs.stat;
	// TODO: consider merging the following with recurseDir ?
	async.eachSeries(_files, function(file, cb) {
		if(typeof file == 'string') {
			stat(file, function(err, stats) {
				if(err) return cb(err);
				
				stats.file = file;
				if(stats.isDirectory()) {
					switch(opts.subdirs) {
						case 'keep':
							// recurse thru subdirs
							(Nyutil || (Nyutil = require('./util'))).recurseDir(file, opts.skipSymlinks, processDirFile, cb);
						return;
						case 'include':
							(Nyutil || (Nyutil = require('./util'))).dirStatList(file, opts.skipSymlinks, function(err, list) {
								if(err) return cb(err);
								async.eachSeries(list, processDirFile, cb);
							});
						return;
						case 'archive':
							files[file] = {archive: true, name: path.basename(file) + '.7z'}; // mark as archive dir
							hasUnseekableFiles = true;
						break;
						case 'archiveAll':
							archiveAll.push(file);
						break;
						case 'skip':
							if(exports.log) exports.log.warn('Skipping directory: ' + file);
					}
				}
				else if(stats.isFile()) {
					if(stats.size || opts.processEmptyFiles) {
						var nam = opts.fileNameTransform(file);
						if(nam || nam === '')
							files[file] = {size: stats.size, name: nam, stat: stats};
					} else if(exports.log)
						exports.log.warn('Skipping empty file: ' + file);
				}
				else if(!stats.isSymbolicLink()) {
					return cb(new Error('Unknown file type for file: ' + file));
				}
				cb();
			});
		} else if(typeof file == 'object') {
			// TODO: consider archiving from streams??
			
			if(!('size' in file))
				return cb(new Error('File size not specified for file ' + file));
			if(!file.name)
				return cb(new Error('File name not specified for file ' + file));
			if(file.stream) {
				files['\0_stream_' + file.name] = file;
				hasUnseekableFiles = true;
			} else if(!file.size) {
				if(opts.processEmptyFiles)
					files['\0_empty_' + file.name] = file;
				else if(exports.log)
					exports.log.warn('Skipping empty file: ' + file.name);
			} else
				return cb(new Error('Invalid file specification ' + file));
			cb();
		} else {
			return cb(new Error('Invalid file specification ' + file));
		}
	}, setImmediate.bind(null, function(err) {
		if(err) return cb(err);
		
		if(archiveAll.length) {
			files['\0_archive'] = {archive: true, name: 'all.7z'}; // TODO: need to make this much better
			hasUnseekableFiles = true;
		}
		
		var filenames = Object.keys(files);
		if(!filenames.length)
			return cb(new Error('No files to process'));
		
		if(opts.encryption) {
			for(var i = 0; i < filenames.length; i++) {
				var encryptedFile = files[filenames[i]];
				if(encryptedFile.size >= 0x100000000)
					return cb(new Error('Encrypted file size must be less than 2^32 bytes'));
				if(encryptedFile.name === '')
					return cb(new Error('Encrypted file name must not be empty'));
			}
		}

		// sort files into collections
		var fileColCount = {};
		// TODO: consider re-ordering ability
		if(opts.groupFiles) {
			// group by base filename
			var re_group_fname = /(\.[a-z0-9]{1,10}){0,2}(\.vol\d+[\-+]\d+\.par2)?(\.\d+|\.part\d+)?$/i;
			filenames.forEach(function(filename) {
				var file = files[filename];
				var col = file.name.replace(re_group_fname, '');
				file.collection = col;
				if(col in fileColCount)
					fileColCount[col]++;
				else
					fileColCount[col] = 1;
				file.num = fileColCount[col];
			});
		} else {
			// one collection
			fileColCount._ = filenames.length;
			var counter = 1;
			filenames.forEach(function(filename) {
				files[filename].collection = '_';
				files[filename].num = counter++;
			});
		}
		
		var reqSize = opts.diskReqSize || (Math.ceil(1048576/opts.articleSize)*opts.articleSize);
		
		if(!hasUnseekableFiles && (opts.check.queueCache === null || opts.check.queueCache === undefined)) {
			// TODO: avoid overwriting?
			// kinda ugly, as we just rely on the Uploader class to set the default if it has unseekable streams...
			opts.check.queueCache = 5;
		}
		
		// if copying input, prepare for it
		var StreamWriter, copyBufPool, StreamTee;
		if(opts.inputCopy) {
			StreamWriter = require('./streamwriter');
			// TODO: do we wish to make the use of BufferPool optional?
			copyBufPool = new (require('./bufferpool'))(reqSize, 0);
			StreamTee = require('./streamtee');
		}
		
		var up = new Uploader(opts, cb);
		ee.emit('start', files, up.uploader);
		up.setupNzbs(files, fileColCount);
		var inputBuffer;
		async.eachSeries(filenames, function(filename, cb) {
			var file = files[filename];
			if(file.archive) {
				// creating an archive of directory
				if(archiveAll.length) {
					// TODO: all dirs into one archive
				} else {
					// TODO:
					
				}
			} else {
				var reader;
				if(!file.stream) {
					if(file.size) {
						if(!inputBuffer)
							inputBuffer = (Buffer.allocUnsafe || Buffer)((opts.diskBufferSize+1) * reqSize);
						reader = new (FileReader || (FileReader = require('./filereader')))(filename, reqSize, inputBuffer);
					}
				} else {
					var stream = file.stream;
					if(typeof stream == 'function') { // to support deferred loading
						stream = stream();
					}
					if((typeof stream != 'object') || !stream.readable)
						return cb(new Error('Cannot read from file ' + file.name));
					
					reader = new (StreamReader || (StreamReader = require('./streamreader')))(stream, opts.diskBufferSize);
				}
				ee.emit('processing_file', file);
				
				// if input copying is enabled, tee the stream out here
				if(opts.inputCopy) {
					var copy = opts.inputCopy;
					if(typeof opts.inputCopy == 'function') {
						copy = opts.inputCopy(file.name, file.size);
					}
					
					if(copy) {
						if(reader) {
							if(!copy.writable) throw new Error('Supplied copy stream is not writable');
							reader = new StreamTee(reader, [new StreamWriter(copy, opts.copyQueueBuffer, file.stream ? null : copyBufPool)]);
						} else
							// empty file - close the copy immediately
							copy.end();
					}
				}
				
				up.addFile(file, fileColCount[file.collection], file.headers || opts.postHeaders, reader, function(err, info) {
					if(err) return cb(err);
					if(reader) reader.close();
					cb(err);
				});
			}
		}, function(err) {
			if(copyBufPool) copyBufPool.drain();
			if(err) {
				// TODO: close input file streams
				up.cancel(err);
			} else {
				up.finished();
				ee.emit('read_complete');
			}
		});
		
	}));
	return ee;
};
