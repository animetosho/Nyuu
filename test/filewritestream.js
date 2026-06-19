"use strict";

var assert = require("assert");

var fwstream = require('../lib/filewritestream');
var toBuffer = (Buffer.alloc ? Buffer.from : Buffer);
var fs = require('fs');
var path = require('path');
var tl = require('./_testlib');

var target = path.join(process.env.TMP || process.env.TEMP || '.', 'fwstream');

['DeferredWriteStream','TempWriteStream'].forEach(function(streamType) {
	describe(streamType, function() {
		
		[false, true].forEach(function(doWrite) {
			it('basic test write='+doWrite, function(done) {
				// delete file if it exists
				try {
					fs.unlinkSync(target);
				} catch(x) {}
				
				var endCalled = false;
				var closed = false;
				var stream = fwstream['create' + streamType](target); // TODO: test options
				stream.on('open', function() {
					assert(!fs.existsSync(target));
					
					(function(cb) {
						if(doWrite)
							stream.write('abc', cb)
						else cb();
					})(function() {
						endCalled = true;
						stream.end(function() {
							setTimeout(function() {
								assert(closed);
								fs.unlinkSync(target);
								done();
							}, 200);
						});
					});
				});
				stream.on('close', function() {
					assert(endCalled);
					assert(fs.existsSync(target));
					closed = true;
				});
			});
			
			it('remove test write='+doWrite, function(done) {
				try {
					fs.unlinkSync(target);
				} catch(x) {}
				
				var endCalled = false;
				var stream = fwstream['create' + streamType](target);
				stream.on('open', function() {
					assert(!fs.existsSync(target));
					
					(function(cb) {
						if(doWrite)
							stream.write('abc', cb)
						else cb();
					})(function() {
						endCalled = true;
						stream.remove(function(err) {
							if(err) throw err;
							
							assert(!fs.existsSync(target));
							done();
						});
					});
				});
				stream.on('close', function() {
					assert(endCalled);
				});
			});
		});
		
	});
});

describe('DeferredWriteStream bytesWritten', function() {
	it('should accumulate bytesWritten across write and end', function(done) {
		try { fs.unlinkSync(target); } catch(x) {}
		
		var stream = fwstream.createDeferredWriteStream(target);
		stream.on('open', function() {
			stream.write('abc', function() {
				assert.equal(stream.bytesWritten, 3);
				stream.end('defg', function() {
					assert.equal(stream.bytesWritten, 7);
					setTimeout(function() {
						fs.unlinkSync(target);
						done();
					}, 200);
				});
			});
		});
		stream.on('close', function() {
			assert(fs.existsSync(target));
		});
	});
});
