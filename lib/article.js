"use strict";

var y = require('yencode');
var ENCODING = 'utf8'; // NOTE: will assume that this is set to 'utf8', 'ascii' or similar; NNTP explicitly assumes this

var RE_BADCHAR = /[\r\n\0]/g;
var AR_CRC = [0,0,0,0];

var BUFFER_ENLARGE_SPACE = 4096; // minimum amount of extra padding to give when enlarging buffers

var toBuffer = Buffer.alloc ? Buffer.from : Buffer;
var NEWLINE = toBuffer('\r\n', ENCODING);

var resizeBuffer = function(size, src, srcLen) {
	var buf = (Buffer.allocUnsafe || Buffer)(size);
	src.copy(buf, 0, 0, srcLen);
	return buf;
};

// TODO: should we switch to single encoding mode if only 1 part?
function MultiEncoder(filename, size, articleSize, line_size, timestamp) {
	if(!line_size) line_size = 128;
	
	this.size = size;
	this.parts = Math.ceil(size / articleSize);
	this.line_size = line_size;
	this.timestamp = timestamp;
	
	this.part = 0;
	this.pos = 0;
	this.crc = toBuffer(AR_CRC);
	
	filename = filename.replace(RE_BADCHAR, '').substr(0, 256);
	this.filename = filename;
	// TODO: long filenames may exceed the line limit?
	this.yInfo = toBuffer(' total='+this.parts+' line='+line_size+' size='+size+' name='+filename+'\r\n=ypart begin=', ENCODING);
	
	this.maxPostSize = y.maxSize(articleSize, line_size)
		+ 75 /* size of fixed strings (incl final CRC) assuming ASCII or similar encoding */
		+ this.yInfo.length
		+ ((this.parts+'').length *2)
		+ ((size+'').length *3);
}
MultiEncoder.prototype = {
	headers: null,
	subjectPre: '', // default subject parameters
	subjectPost: '',
	setHeaders: function(headers, defSubjectPre, defSubjectPost) {
		this.headers = {};
		for(var h in headers) {
			var v = headers[h];
			if(typeof v == 'function')
				this.headers[h] = v.bind(null, this.filename, this.size);
			else if(h.toLowerCase() == 'subject' && v === null) {
				this.subjectPre = defSubjectPre.replace(RE_BADCHAR, '');
				this.subjectPost = defSubjectPost.replace(RE_BADCHAR, '');
				this.headers[h] = v;
			} else if(v)
				this.headers[h] = v.replace(RE_BADCHAR, '');
			else {
				if(h.toLowerCase() == 'date' && this.timestamp)
					this.headers[h] = this.timestamp.toUTCString();
				else
					this.headers[h] = v;
			}
		}
	},
	// if caller wants the generated headers, pass an empty object as grabHeaders
	generate: function(data, pool, grabHeaders) {
		this.part++;
		if(this.part > this.parts)
			throw new Error('Exceeded number of specified yEnc parts');
		var end = this.pos + data.length;
		if(end > this.size)
			throw new Error('Exceeded total file size');
		
		var crc = y.crc32(data);
		var fullCrc = ' pcrc32=' + crc.toString('hex');
		this.crc = y.crc32_combine(this.crc, crc, data.length);
		if(this.part == this.parts) {
			// final part treated slightly differently
			if(end != this.size)
				throw new Error('File size doesn\'t match total data length');
			fullCrc += ' crc32='+this.crc.toString('hex');
		}
		
		var post = pool ? new PooledPost(this, pool) : new UnpooledPost(this);
		
		var headers = {};
		for(var h in this.headers) {
			var v = this.headers[h];
			var hl = h.toLowerCase();
			if(hl == 'subject' && v === null) {
				// default subject
				v = this.subjectPre + this.part + this.subjectPost;
			} else {
				if(typeof v == 'function')
					v = v(this.part, this.parts, data.length).replace(RE_BADCHAR, '');
				
				if(hl == 'date' && !v)
					v = (new Date(post.genTime)).toUTCString();
			}
			
			headers[h] = v;
			if(grabHeaders) grabHeaders[hl] = v;
		}
		post._setHeaders(headers);
		
		post._setData(data, this.part, this.pos, fullCrc);
		
		this.pos = end;
		return post;
	}
};

// pessimistic maximum size of an encoded article
// does not consider the effect of ENCODING, but assumes that it's sane
MultiEncoder.maxSize = function(size, line_size) {
	return 1237 + y.maxSize(size, line_size);
	/* the above is derived from:
	return
		  13 // '=ybegin part='
		+ 10 // len(2^32)
		+  7 // ' total='
		+ 10 // len(2^32)
		+  6 // ' line='
		+  4 // thousands of chars/line
		+  6 // ' size='
		+ 16 // len(2^53)
		+  6 // ' name='
		+1024// a fairly long filename: 256 4-byte characters
		+  2 // '\r\n'
		+ 13 // '=ypart begin='
		+ 16 // len(2^53)
		+  5 // ' end='
		+ 16 // len(2^53)
		+  2 // '\r\n'
		+ y.maxSize(size, line_size)
		+ 13 // '\r\n=yend size='
		+ 16 // len(2^53)
		+  6 // ' part='
		+ 10 // len(2^32)
		+  8 // ' pcrc32='
		+  8 // len(hex(crc32))
		+  7 // ' crc32='
		+  8 // len(hex(crc32))
		+  5 // '\r\n.\r\n'
	;
	*/
};

MultiEncoder.fromBuffer = function(buf) {
	return new RawPost(buf);
};

// something that isn't as slow as crypto.pseudoRandomBytes
var randString = function() {
  var text = "";
  var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  for (var i = 0; i < 64; i++)
    text += possible.charAt(Math.floor(Math.random() * possible.length));

  return text;
};

function Post(parent) {
	this.parent = parent;
	this.messageId = randString();
}
Post.prototype = {
	genTime: null,
	
	pos: null,
	part: null,
	crcFrag: null,
	data: null,
	postLen: null,
	postPos: 0,
	
	reload: null, // overwrite this with a function defining how to reload the post into memory
	
	keepMessageId: false,
	_msgIdOffset: 13, /* 'Message-ID: <'.length */
	
	_setData: function(data, part, pos, crcFrag) {
		this.part = part;
		this.pos = pos;
		this.crcFrag = crcFrag;
		this.inputLen = data.length;
	},
	
	randomizeMessageID: function() {
		var rnd = randString();
		this.data.write(rnd, this._msgIdOffset, ENCODING);
		return this.messageId = rnd + this.messageId.substr(24);
	},
	
	_getHeadersStr: function() {
		if(!this.data) return null;
		return this.data.slice(0, this.postPos).toString(ENCODING);
	},
	
	// NOTE: getHeader and stripHeader won't work for the first header (i.e. Message-ID)
	getHeader: function(str) {
		var headers = this._getHeadersStr();
		if(!headers) return null;
		var m = headers.match(new RegExp('\r\n' + str.toLowerCase() + ': *(.*?)\r\n', 'i'));
		if(m) return m[1];
		return false;
	},
	
	// strips a header from a materialized post
	// this is only used as a workaround for some servers rejecting posts but allowing them through if a header is removed
	stripHeader: function(str) {
		// convert post's headers back to a string to find indexes to chop off
		var headers = this._getHeadersStr().toLowerCase();
		var from = headers.indexOf('\r\n' + str.toLowerCase() + ':');
		if(from < 0) return false;
		var to = headers.indexOf('\r\n', from+2);
		
		if(from < 0 || to < 0 || from >= to) return false; // should never occur, but just in case...
		
		// account for character encodings
		to = Buffer.byteLength(headers.substr(from, to-from), ENCODING);
		from = Buffer.byteLength(headers.substr(0, from), ENCODING);
		to += from;
		
		// move data down in buffer
		this.data.copy(this.data, from, to);
		this.postPos -= to-from;
		this.data = this.data.slice(0, this.postPos + this.postLen);
		
		return true;
	},
	
	releaseData: function() {
		this.release();
	},
	release: function() {
		this.data = null;
	}
};


function PooledPost(parent, pool) {
	Post.call(this, parent);
	this.pool = pool;
}
PooledPost.prototype = Object.create(Post.prototype);
PooledPost.prototype.pool = null;
PooledPost.prototype.buf = null;
PooledPost.prototype._headerStr = null;
PooledPost.prototype._setHeaders = function(headers) {
	this.buf = this.pool.get();
	while(1) {
		this.postPos = this.buf.write('Message-ID: <' + this.messageId + '>\r\n', 0, ENCODING);
		for(var h in headers) {
			this.postPos += this.buf.write(h + ': ' + headers[h] + '\r\n', this.postPos, ENCODING);
		}
		this.postPos += NEWLINE.length;
		if(this.postPos >= this.buf.length) {
			// likely overflowed, try again
			this.buf = (Buffer.allocUnsafe || Buffer)(this.postPos + Math.max(this.buf.length, BUFFER_ENLARGE_SPACE));
			this.postPos = 0;
			continue;
		}
		NEWLINE.copy(this.buf, this.postPos-NEWLINE.length);
		break;
	}
};
PooledPost.prototype._writeData = function(data) {
	var bufPos = this.postPos;
	bufPos += this.buf.write('=ybegin part='+this.part, bufPos, ENCODING);
	this.parent.yInfo.copy(this.buf, bufPos);
	bufPos += this.parent.yInfo.length;
	bufPos += this.buf.write(( this.pos+1 )+' end='+(this.pos + data.length)+'\r\n', bufPos, ENCODING);
	bufPos += y.encodeTo(data, this.buf.slice(bufPos), this.parent.line_size);
	bufPos += this.buf.write('\r\n=yend size='+data.length+' part='+this.part+this.crcFrag+'\r\n.\r\n', bufPos, ENCODING);
	
	this.data = this.buf.slice(0, bufPos);
	return bufPos - this.postPos;
};
PooledPost.prototype._setData = function(data, part, pos, crcFrag) {
	Post.prototype._setData.apply(this, arguments);
	
	var bufPos = this.postPos;
	var minSpace = bufPos + this.parent.maxPostSize;
	// ensure we have enough space
	if(this.buf.length < minSpace)
		this.buf = resizeBuffer(minSpace, this.buf, bufPos);
	// newly created buffers should be at least this size
	if(this.pool.size < minSpace)
		this.pool.size = minSpace + BUFFER_ENLARGE_SPACE;
	
	this.postLen = this._writeData(data);
};
PooledPost.prototype.release = function() {
	if(this.buf) {
		this.pool.put(this.buf);
		this.buf = null;
	}
	Post.prototype.release.call(this);
};
PooledPost.prototype._getHeadersStr = function() {
	if(!this.data && this._headerStr)
		return this._headerStr;
	return Post.prototype._getHeadersStr.call(this);
};
PooledPost.prototype.releaseData = function() {
	this._headerStr = this._getHeadersStr();
	this.release();
};
PooledPost.prototype.reloadData = function(data) {
	if(this.inputLen != data.length)
		throw new Error('Supplied buffer is of incorrect length');
	this.buf = this.pool.get();
	if(this.postPos != this.buf.write(this._headerStr, 0, ENCODING))
		throw new Error('Header length mismatch encountered');
	if(this.postLen != this._writeData(data))
		throw new Error('Article length mismatch encountered');
	
	this._headerStr = null;
};

function UnpooledPost(parent) {
	Post.call(this, parent);
}
UnpooledPost.prototype = Object.create(Post.prototype);
UnpooledPost.prototype.bufs = null;
UnpooledPost.prototype._addHeader = function(data) {
	var d = toBuffer(data + '\r\n', ENCODING);
	this.postPos += d.length;
	this.bufs.push(d);
};
UnpooledPost.prototype._setHeaders = function(headers) {
	this.bufs = [];
	this._addHeader('Message-ID: <' + this.messageId + '>');
	for(var h in headers) {
		this._addHeader(h + ': ' + headers[h]);
	}
	this.bufs.push(NEWLINE);
	this.postPos += NEWLINE.length;
};
UnpooledPost.prototype._writeData = function(data) {
	this.bufs.push(
		toBuffer('=ybegin part='+this.part, ENCODING),
		this.parent.yInfo,
		toBuffer(( this.pos+1 )+' end='+(this.pos + data.length)+'\r\n', ENCODING),
		y.encode(data, this.parent.line_size),
		toBuffer('\r\n=yend size='+data.length+' part='+this.part+this.crcFrag+'\r\n.\r\n', ENCODING)
	);
	this.data = Buffer.concat(this.bufs);
	this.bufs = null;
	return this.data.length - this.postPos;
};
UnpooledPost.prototype._setData = function(data, part, pos, crcFrag) {
	Post.prototype._setData.apply(this, arguments);
	
	this.postLen = this._writeData(data);
};
UnpooledPost.prototype._getHeadersStr = function() {
	if(!this.data && this.bufs && this.bufs.length == 1)
		return this.bufs[0].toString(ENCODING);
	return Post.prototype._getHeadersStr.call(this);
};
UnpooledPost.prototype.releaseData = function() {
	this.bufs = [toBuffer(this.data.slice(0, this.postPos))];
	this.release();
};
UnpooledPost.prototype.reloadData = function(data) {
	if(this.postLen != this._writeData(data))
		throw new Error('Article length mismatch encountered');
};


var bufferFind;
if(Buffer.prototype.indexOf)
	bufferFind = function(buf, search) {
		return buf.indexOf(search, ENCODING);
	};
else
	bufferFind = function(buf, search) {
		if(!Buffer.isBuffer(search))
			search = toBuffer(search, ENCODING);
		if(search.length == 0) return 0;
		if(search.length > buf.length) return -1;
		
		for(var i = 0; i < buf.length - search.length + 1; i++) {
			var match = true;
			for(var j = 0; j < search.length; j++) {
				if(buf[i+j] != search[j]) {
					match = false;
					break;
				}
			}
			if(match) return i;
		}
		return -1;
	};


var crypto;

// similar to Post, but constructed from a buffer
function RawPost(data) {
	var headers = {};
	
	this.data = this.buf = data;
	this.postPos = bufferFind(data, '\r\n\r\n');
	if(this.postPos <= 0) throw new Error('Could not parse post');
	
	var hdr = data.slice(0, this.postPos).toString(ENCODING).split('\r\n');
	this.postPos += 4; // '\r\n\r\n'.length
	
	var self = this;
	var p = 0, msgIdLen;
	hdr.forEach(function(h) {
		var m = h.match(/^(.*?)\:(.*)$/);
		if(!m || !m[1])
			throw new Error('Invalid header line: "' + h + '"');
		var k = m[1].trim().toLowerCase(),
		    v = m[2].trim();
		headers[k] = v;
		if(k == 'message-id') {
			self._msgIdOffset = p + k.length + 1;
			msgIdLen = h.length - k.length - 1;
			if(m[2][0] == ' ') {
				msgIdLen--;
				self._msgIdOffset++;
			}
		}
		p += Buffer.byteLength(h, ENCODING) + 2;
	});
	
	var m;
	if(!headers['message-id'] || !(m = headers['message-id'].match(/^<(.*)>$/)))
		throw new Error('Post lacks a valid Message-ID header!');
	
	msgIdLen -= 2; // strip out angle brackets from the length
	if(msgIdLen < 1)
		throw new Error('Message-ID too short');
	
	this.messageId = m[1];
	if(msgIdLen < 16 + messageIdSuffix.length) {
		// rather short... make whole thing random
		this.randomizeMessageID = function() {
			self.messageId = (crypto || (crypto = require('crypto'))).pseudoRandomBytes(msgIdLen-2).toString('base64').substr(0, msgIdLen);
			self.data.write('<' + self.messageId + '>', self._msgIdOffset, ENCODING);
			return self.messageId;
		};
	} else {
		this.randomizeMessageID = function() {
			var id = '-' + self.genTime + messageIdSuffix;
			var targetLen = msgIdLen - id.length;
			for(var i=0; i<targetLen; i+=24)
				id = randString() + id;
			id = id.substr(id.length - msgIdLen);
			self.data.write('<' + id + '>', self._msgIdOffset, ENCODING);
			return self.messageId = id;
		};
	}
	
	if(headers.date)
		this.genTime = (new Date(headers.date)).getTime();
	else
		this.genTime = Date.now();
	
	// TODO: set post.inputLen?
	
	this.data = this.buf;
	this.postLen = data.length - this.postPos;
	this.keepMessageId = true;
}
RawPost.prototype = Object.create(Post.prototype);

RawPost.prototype.reloadData = function(data) {
	this.data = data;
	if(this.postLen != data.length - this.postPos)
		throw new Error('Article length mismatch encountered');
};

module.exports = MultiEncoder;
