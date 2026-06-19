"use strict";

var stream = require('stream');
var util = require('util');
var toBuffer = (Buffer.alloc ? Buffer.from : Buffer);
var fs = require('fs');

function DeferredFileWriteStream(options) {
	stream.Writable.call(this, options);
	this.buffers = [];
	this.bytesWritten = 0;
	process.nextTick(this.emit.bind(this, 'open'));
}
util.inherits(DeferredFileWriteStream, stream.Writable);

DeferredFileWriteStream.prototype._write = function(chunk, encoding, cb) {
	if(!cb && typeof encoding == 'function') {
		cb = encoding;
		encoding = null;
	}
	var buf = toBuffer(chunk, encoding || this.opts.encoding);
	this.buffers.push(buf);
	this.bytesWritten += buf.length;
	cb();
};

DeferredFileWriteStream.prototype._writev = function(chunks, cb) {
	var optsEncoding = this.opts.encoding;
	var len = 0;
	this.buffers.push.apply(this.buffers, chunks.map(function(chunk) {
		var buf = toBuffer(chunk.chunk, chunk.encoding || optsEncoding);
		len += buf.length;
		return buf;
	}));
	this.bytesWritten += len;
	cb();
};

DeferredFileWriteStream.prototype.end = function(chunk, encoding, cb) {
	if(!cb && !encoding && typeof chunk == 'function') {
		cb = chunk;
		chunk = null;
	} else if(!cb && typeof encoding == 'function') {
		cb = encoding;
		encoding = null;
	}
	if(chunk) {
		var buf = toBuffer(chunk, encoding || this.opts.encoding);
		this.bytesWritten += buf.length;
		this.buffers.push(buf);
	}
	var self = this;
	if(fs.writev) {
		fs.open(this.path, this.opts.flags || 'w', this.opts.mode || 438/*0o666*/, function(err, fd) {
			if(err) return cb(err);
			fs.writev(fd, self.buffers, function(err) {
				// TODO: flush option support?
				fs.close(fd, function(err2) {
					if(self.opts.emitClose !== false) self.emit('close');
					cb(err || err2);
				});
			});
		});
	} else {
		fs.writeFile(this.path, Buffer.concat(this.buffers), this.opts, function(err) {
			if(self.opts.emitClose !== false) self.emit('close');
			cb(err);
		});
	}
};

DeferredFileWriteStream.prototype.remove = function(cb) {
	this.buffers = [];
	cb();
};
DeferredFileWriteStream.prototype.removeSync = function() {
	this.buffers = [];
};



function TempFileWriteStream(path, options) {
	this.targetPath = path;
	path += '.' + Date.now() + '_' + Math.floor(Math.random() * 1000000);
	fs.WriteStream.call(this, path, options);
	
	if(this._writableState && !this._writableState.emitClose && (!options || !('emitClose' in options))) {
		// some versions of Node don't default this to true, so fix it up
		this._writableState.emitClose = true;
	}
}
util.inherits(TempFileWriteStream, fs.WriteStream);
// TODO: need to overwrite close?
TempFileWriteStream.prototype.end = function(chunk, encoding, cb) {
	if(!cb && !encoding && typeof chunk == 'function') {
		cb = chunk;
		chunk = null;
	} else if(!cb && typeof encoding == 'function') {
		cb = encoding;
		encoding = null;
	}
	
	var self = this;
	
	// swallow the 'close' event
	this.realEmit = this.emit;
	this.emit = function(event) {
		if(event != 'close')
			self.realEmit.apply(self, arguments);
	};
	fs.WriteStream.prototype.end.call(this, chunk, encoding, function(err) {
		if(err) return cb(err);
		
		fs.rename(self.path, self.targetPath, function(err) {
			// restore original emit function
			self.emit = self.realEmit;
			delete self.realEmit;
			
			if(!self._writableState || self._writableState.emitClose !== false) self.emit('close');
			cb(err);
		});
	});
};
TempFileWriteStream.prototype.remove = function(cb) {
	var path = this.path;
	fs.WriteStream.prototype.end.call(this, function() {
		fs.unlink(path, cb);
	});
};
TempFileWriteStream.prototype.removeSync = function() {
	fs.WriteStream.prototype.destroy.call(this);
	fs.unlinkSync(this.path);
};


function FileWriteStream(path, options) {
	fs.WriteStream.apply(this, arguments);
}
util.inherits(FileWriteStream, fs.WriteStream);
FileWriteStream.prototype.remove = TempFileWriteStream.prototype.remove;
FileWriteStream.prototype.removeSync = TempFileWriteStream.prototype.removeSync;


module.exports = {
	createDeferredWriteStream: function(path, opts) {
		var stream = new DeferredFileWriteStream(opts);
		stream.path = path;
		stream.opts = opts || {}; // probably a duplicate of stream._writableState, though the latter is undocumented
		return stream;
	},
	createTempWriteStream: function(path, opts) {
		return new TempFileWriteStream(path, opts);
	},
	createWriteStream: function(path, opts) {
		return new FileWriteStream(path, opts);
	}
};
