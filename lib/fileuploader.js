"use strict";

var async = require('async');
var path = require('path');
var fs = require('fs');
var Uploader = require('./uploadmgr');
var StreamReader, FileReader;
var EventEmitter = require('events').EventEmitter;
var Nyutil;

exports.log = null;
exports.setLogger = function(log) {
	exports.log = log;
	Uploader.setLogger(log);
};

exports.upload = function(_files, opts, cb) {
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
