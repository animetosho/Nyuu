"use strict";

var async = require('async');
var ArticleEncoder = require('./article');
var util = require('./util');
var Uploader = require('./uploader');

// optional includes
var NZB, BufferPool, fs, fwStream, zlib;

var RE_QUOTE = /"/g;
var AR_NZB_OVR = ['subject', 'poster', 'groups', 'date'];

var trim = function(s) {
	return s.trim();
};

var reloadPost = function(post, stream, size, pool, cb) {
	if(post.data) throw new Error('Attempt to reload post that already has been loaded');
	var buf = pool ? pool.get() : (Buffer.allocUnsafe || Buffer)(size);
	stream.readRange((post.part-1) * size, buf, function(err, data) {
		if(!err) post.reloadData(data);
		if(pool) pool.put(buf);
		cb(err);
	});
};
var emptyBuffer = (Buffer.allocUnsafe || Buffer)(0);
var reloadPostEmpty = function(post, cb) {
	if(post.data) throw new Error('Attempt to reload post that already has been loaded');
	post.reloadData(emptyBuffer);
	cb(null);
};

var createNzb = function(opts) {
	var outStream;
	if(typeof opts.writeTo == 'string') {
		var createStream;
		if(opts.fileMode == 'defer')
			createStream = (fwStream || (fwStream = require('./filewritestream'))).createDeferredWriteStream;
		else if(opts.fileMode == 'temp')
			createStream = (fwStream || (fwStream = require('./filewritestream'))).createTempWriteStream;
		else
			createStream = (fs || (fs = require('fs'))).createWriteStream;
		outStream = createStream(opts.writeTo, opts.writeOpts);
	}
	else if(typeof opts.writeTo == 'function') {
		outStream = opts.writeTo();
		if(typeof outStream != 'object' || !outStream.writable) // assume writable stream
			throw new Error('Invalid value for nzb.writeTo');
	} else if(typeof opts.writeTo == 'object' && opts.writeTo.writable) // assume writable stream
		outStream = opts.writeTo;
	else
		throw new Error('Invalid value for nzb.writeTo');
	
	if(opts.corkOutput && outStream.cork)
		outStream.cork();
	
	var nzbStream = outStream;
	switch(opts.compression) {
		case 'gzip':
			nzbStream = (zlib || (zlib = require('zlib'))).createGzip(opts.compressOpts);
			nzbStream.pipe(outStream);
		break;
		case 'deflate':
			nzbStream = (zlib || (zlib = require('zlib'))).createDeflateRaw(opts.compressOpts);
			nzbStream.pipe(outStream);
		break;
		case 'zlib':
			nzbStream = (zlib || (zlib = require('zlib'))).createDeflate(opts.compressOpts);
			nzbStream.pipe(outStream);
		break;
		case 'brotli':
			if(!zlib) zlib = require('zlib');
			var cOpts = util.extend({}, opts.compressOpts || {});
			if(cOpts.level !== undefined && cOpts[zlib.constants.BROTLI_PARAM_QUALITY] === undefined) {
				cOpts[zlib.constants.BROTLI_PARAM_QUALITY] = cOpts.level;
				delete cOpts.level;
			}
			if(cOpts[zlib.constants.BROTLI_PARAM_MODE] === undefined) // default to signalling text
				cOpts[zlib.constants.BROTLI_PARAM_MODE] = zlib.constants.BROTLI_MODE_TEXT;
			nzbStream = zlib.createBrotliCompress({params: cOpts});
			nzbStream.pipe(outStream);
		break;
	}
	var nzb = new (NZB || (NZB = require('./nzbbuffer')))(
		opts.metaData,
		nzbStream.write.bind(nzbStream),
		opts.minify,
		opts.writeOpts ? opts.writeOpts.encoding : ''
	);
	// errors will throw by default
	nzb.stream = nzbStream;
	nzb.overrides = opts.overrides || {};
	return nzb;
};
var closeNzb = function(nzb, deleteOnErr, err, cb) {
	if(!deleteOnErr || !nzb.stream.path)
		nzb.end(!!err);
	(function(cb) {
		if(
			nzb.stream !== process.stdout && nzb.stream !== process.stderr // stdio cannot be closed
			&& !(deleteOnErr && err && nzb.stream.remove) // skip closing if the file needs to be purged instead
		) {
			if(UploadManager.log) {
				nzb.stream.on('error', function(err) {
					UploadManager.log.warn('Exception raised when trying to close NZB stream: ' + err);
				});
				try {
					nzb.stream.end(cb);
				} catch(x) {
					UploadManager.log.warn('Exception raised when trying to close NZB stream: ' + x);
					cb();
				}
			} else {
				nzb.stream.end(cb);
			}
		} else cb();
	})(function() {
		if(deleteOnErr && err) {
			if(nzb.stream.remove)
				return nzb.stream.remove(function(err) {
					if(err && UploadManager.log)
						UploadManager.log.warn('Failed to delete NZB "' + nzb.stream.path + '": ' + err);
					cb();
				});
			else if(nzb.stream.path) {
				return (fs || (fs = require('fs'))).unlink(nzb.stream.path, function(err) {
					if(err && UploadManager.log)
						UploadManager.log.warn('Failed to delete NZB "' + nzb.stream.path + '": ' + err);
					cb();
				});
			}
		}
		cb();
	});
};

function UploadManager(opts, cb) {
	this.opts = opts;
	this.articleSize = opts.articleSize || 768000;
	
	this.nzbs = {};
	this.uploader = new Uploader(opts, function(err) {
		if(this.crashHandler) {
			process.removeListener('finished', this.crashHandler);
			this.crashHandler = null;
		}
		var toClose = [];
		for(var k in this.nzbs) {
			if(this.nzbs[k].nzb)
				toClose.push(this.nzbs[k].nzb);
		}
		async.each(toClose, function(nzb, cb) {
			closeNzb(nzb, opts.nzbDelIncomplete, err, cb);
		}, function() {
			cb(err);
		});
		// TODO: cancel reading if error
		// TODO: add ability to upload NZBs
		//  for this, the uploading section can't close the connections
	}.bind(this));
	if(opts.nzbDelIncomplete) {
		this.crashHandler = this.onUncaughtException.bind(this);
		process.once('finished', this.crashHandler);
	}
	
	if(opts.useBufferPool !== false) {
		if(!BufferPool)
			BufferPool = require('./bufferpool');
		this.bufferPool = new BufferPool(ArticleEncoder.maxSize(this.articleSize, opts.bytesPerLine) + opts.headerAllocSize, BufferPool.calcSizeForUpload(this.uploader, opts.servers), opts.useSharedBuffers);
		this.reloadBufPool = new BufferPool(this.articleSize, null, opts.useSharedBuffers);
	}
	
	this.dateOverride = opts.postDate;
	if(this.dateOverride && !(this.dateOverride instanceof Date))
		this.dateOverride = new Date(this.dateOverride);
}
UploadManager.prototype = {
	nzbs: null,
	bufferPool: null,
	reloadBufPool: null,
	dateOverride: null,
	crashHandler: null,
	
	setupNzbs: function(files, collectionCounts) {
		if(!this.opts.nzb) return;
		
		if(typeof this.opts.nzb == 'function') {
			for(var filename in files) {
				var file = files[filename];
				var nzb = this.opts.nzb(file.num, collectionCounts[file.collection], file.name, file.size, 1, Math.max(1, Math.ceil(file.size / this.articleSize)));
				if(nzb) {
					if(!Array.isArray(nzb))
						throw new Error('Invalid NZB specification supplied for file: ' + fileName);
					if(!this.nzbs[nzb[0]]) {
						if(nzb.length != 2 || typeof nzb[1] != 'object')
							throw new Error('Invalid NZB specification supplied for file: ' + fileName);
						if(nzb[1].writeTo === null || nzb[1].writeTo === undefined)
							continue; // assume user intended to not write any output (consistent with default setup)
						this.nzbs[nzb[0]] = {
							count: 1,
							create: nzb[1],
							nzb: null
						};
					} else {
						this.nzbs[nzb[0]].count++;
					}
					file.nzbId = nzb[0];
				}
			}
		}
		else if(this.opts.nzb.writeTo !== null && this.opts.nzb.writeTo !== undefined) {
			// single NZB output -> map to '_'
			this.nzbs._ = {
				count: 0,
				create: this.opts.nzb,
				nzb: null
			};
			for(var filename in files) {
				var file = files[filename];
				file.nzbId = '_';
				this.nzbs._.count++;
			}
		}
	},
	onUncaughtException: function() {
		// opts.nzbDelIncomplete is true here
		try {
			if(!fs) fs = require('fs');
			for(var nzbI in this.nzbs) {
				var nzb = this.nzbs[nzbI];
				if(!nzb || !nzb.nzb || !nzb.nzb.stream) continue;
				var stream = nzb.nzb.stream;
				if(stream.removeSync) {
					try {
						stream.removeSync();
					} catch(err) {
						if(UploadManager.log)
							UploadManager.log.warn('Failed to delete NZB "' + stream.path + '": ' + err);
					}
				} else if(stream.path) {
					stream.destroy();
					try {
						fs.unlinkSync(stream.path);
					} catch(err) {
						if(UploadManager.log)
							UploadManager.log.warn('Failed to delete NZB "' + stream.path + '": ' + err);
					}
				}
			}
		} catch(x) {}
	},
	
	addFile: function(file, fileNumTotal, postHeaders, stream, fileDone) {
		var enc = new ArticleEncoder(file.name, file.size, this.articleSize, this.dateOverride, {
			encoding: this.opts.articleEncoding,
			line_size: this.opts.bytesPerLine,
			name: typeof this.opts.yencName == 'function' ? this.opts.yencName.bind(null, file.num, fileNumTotal) : this.opts.yencName
		});
		var sizes = [];
		var self = this;
		var numParts = Math.max(1, Math.ceil(file.size / self.articleSize));
		var nzbFile;
		var nzb = this.nzbs[file.nzbId];
		if(nzb && nzb.create) {
			nzb.nzb = createNzb(nzb.create);
			nzb.create = null;
			nzb.nzb.numFiles = nzb.count;
		}
		
		if(typeof postHeaders == 'function')
			postHeaders = postHeaders(file.num, fileNumTotal, file.name, file.size, 1, numParts);
		var headers = util.extend({}, postHeaders);
		
		// default subject: pre-generate most of it - only the thing that needs customising, is the part number
		var preSubj = '';
		if(this.opts.comment) preSubj = this.opts.comment + ' ';
		if(fileNumTotal > 1)
			preSubj += '[' + '0000000000000000'.substring(0, (''+fileNumTotal).length - (''+file.num).length) + file.num + '/' + fileNumTotal + '] - ';
		// TODO: should we revert to single part titles if only 1 part?
		preSubj += '"' + file.name.replace(RE_QUOTE, '') + '" yEnc (';
		var postSubj = '/' + enc.parts + ') ' + file.size + (this.opts.comment2 ? ' ' + this.opts.comment2 : '');
		
		// bind in file.num/fileNumTotal to functions
		for(var k in headers) {
			if(typeof headers[k] == 'function') {
				headers[k] = headers[k].bind(null, file.num, fileNumTotal);
			}
		}
		enc.setHeaders(headers, preSubj, postSubj);
		
		var submitPost = function(buffer, cb) {
			var postHeaders;
			if(nzb && !nzbFile) postHeaders = {};
			var post = enc.generate(buffer, self.bufferPool, postHeaders);
			sizes.push(post.postLen);
			post.keepMessageId = self.opts.keepMessageId;
			if(nzb) {
				if(!nzbFile) {
					var nzbArgs = [
						// the subject that the NZB takes is actually the subject of the first post (where counter is (1/xx))
						postHeaders.subject || '',
						postHeaders.from || '',
						postHeaders.newsgroups || '',
						numParts,
						post.genTime
					];
					AR_NZB_OVR.forEach(function(k, i) {
						var ov = nzb.nzb.overrides[k];
						if(i == 3) i++; // ugly hack for 'date'
						if(typeof ov == 'function') {
							ov = ov(file.num, fileNumTotal, file.name, file.size, 1, nzbArgs[3], nzbArgs[i]);
						}
						if(ov !== null && ov !== undefined)
							nzbArgs[i] = ov;
					});
					// fix newsgroups/date lines
					if(!Array.isArray(nzbArgs[2]))
						nzbArgs[2] = nzbArgs[2].split(',').map(trim);
					if((typeof nzbArgs[4] != 'number') && !(nzbArgs[4] instanceof Date))
						nzbArgs[4] = new Date(nzbArgs[4]);
					nzbFile = nzb.nzb.file.apply(nzb.nzb, nzbArgs);
				}
				post.nzbSeg = nzbFile.set.bind(nzbFile, post.part-1, post.postLen);
			}
			if(stream && stream.readRange) // reloadable post
				post.reload = reloadPost.bind(null, post, stream, self.articleSize, self.reloadBufPool);
			else if(!file.size)
				post.reload = reloadPostEmpty.bind(null, post);
			self.uploader.addPost(post, setImmediate.bind(null, cb), self.onPosted.bind(self, post));
		};
		if(!file.size) {
			// upload single post for empty file - don't need to read from a stream
			return submitPost(emptyBuffer, function() {
				fileDone(null, {
					sizes: sizes,
					crc32: enc.crc32
				});
			});
		}
		
		var sizeRead = 0;
		(function readLoop() {
			stream.read(self.articleSize, function(err, buffer) {
				if(err || !buffer.length) { // EOF / error
					if(!err && file.size != sizeRead)
						err = new Error('Bytes read from file (' + sizeRead + ') does not match size of file (' + file.size + ')');
					return fileDone(err, {
						sizes: sizes,
						crc32: enc.crc32
					});
				}
				sizeRead += buffer.length;
				submitPost(buffer, readLoop);
			});
		})();
	},
	onPosted: function(post, err) {
		if(post.nzbSeg) {
			// the following will skip writing a segment if the Message-ID is invalid
			post.nzbSeg(post.messageId);
		}
		post.release();
	},
	cancel: function(reason) {
		// TODO: cancel upload
		this.uploader.cancel(reason);
	},
	finished: function() {
		this.uploader.finished();
	}
};

UploadManager.log = null;
module.exports = UploadManager;
UploadManager.setLogger = function(log) {
	UploadManager.log = log;
	Uploader.setLogger(log);
};
