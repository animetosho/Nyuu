"use strict";

var y = require('yencode');

var cryptoUtil, ff1;
function loadCrypto() {
	if(!cryptoUtil) {
		cryptoUtil = require('./crypto');
		ff1 = require('./ff1');
	}
}

var RE_BADCHAR = /[\r\n\0]/g;
var RE_BADMSGIDCHAR = /[^\u0020-\u007F]/g;
var AR_CRC = [0,0,0,0];

var BUFFER_ENLARGE_SPACE = 4096; // minimum amount of extra padding to give when enlarging buffers
var MAX_NAME_LENGTH = 1024; // maximum byte length of the yEnc 'name' header (used for filenames); although filenames with paths can be quite long, we need to keep in mind that yEnc typically has a per-line length limit of around 128 bytes

var toBuffer = Buffer.alloc ? Buffer.from : Buffer;
var NEWLINE = toBuffer('\r\n', 'ascii');
var bufferSlice = Buffer.prototype.readBigInt64BE ? Buffer.prototype.subarray : Buffer.prototype.slice;

var resizeBuffer = function(size, src, srcLen) {
	var buf = (Buffer.allocUnsafe || Buffer)(size);
	src.copy(buf, 0, 0, srcLen);
	return buf;
};

var crypto = require('crypto');

function dotStuffEncryptedLines(body) {
	// RFC 3977 §3.1.1: any article line starting with '.' (0x2E) must be dot-stuffed,
	// except the article terminator line (".\r\n" at the very end of the data).
	var terminatorPos = (body.length >= 3 && body[body.length - 3] === 0x2E && body[body.length - 2] === 0x0D && body[body.length - 1] === 0x0A) ? body.length - 3 : -1;
	var extraDots = 0;
	var atLineStart = true;
	for(var i = 0; i < body.length; i++) {
		if(atLineStart && body[i] === 0x2E && i !== terminatorPos) {
			extraDots++;
		}
		atLineStart = (body[i] === 0x0A);
	}
	if(extraDots === 0) return body;
	var out = Buffer.alloc(body.length + extraDots);
	var outPos = 0;
	atLineStart = true;
	for(var i = 0; i < body.length; i++) {
		if(atLineStart && body[i] === 0x2E && i !== terminatorPos) {
			out[outPos++] = 0x2E;
		}
		out[outPos++] = body[i];
		atLineStart = (body[i] === 0x0A);
	}
	return out;
}

// TODO: should we switch to single article mode if only 1 part?
function MultiEncoder(filename, size, articleSize, timestamp, opts) {
	if(!opts) opts = {};
	this.size = size;
	this.parts = Math.max(1, Math.ceil(size / articleSize));
	this.line_size = opts.line_size || 128;
	this.timestamp = timestamp;
	this.encoding = opts.encoding || 'utf8';
	this.encryption = opts.encryption || null;
	
	this.part = 0;
	this.pos = 0;
	this.crc = toBuffer(AR_CRC);
	
	this.filename = filename;
	if(opts.name !== undefined && opts.name !== null) {
		if(typeof opts.name == 'function')
			filename = opts.name(filename, size, 1, this.parts);
		else
			filename = opts.name;
	}
	filename = filename.replace(RE_BADCHAR, '');
	var yiPre = ' total='+this.parts+' line='+this.line_size+' size='+size+' name=', yiSuf = '\r\n=ypart begin=';
	var nameEnc = this.encryption ? 'utf8' : this.encoding;
	this.yInfo = (Buffer.allocUnsafe || Buffer)(Buffer.byteLength(yiPre + yiSuf, this.encoding) + MAX_NAME_LENGTH);
	var p = this.yInfo.write(yiPre, 0, this.yInfo.length, this.encoding);
	var nameStart = p;
	p += this.yInfo.write(filename, p, MAX_NAME_LENGTH, nameEnc);
	if(this.encryption)
		this.nameBytes = bufferSlice.call(this.yInfo, nameStart, p);
	p += this.yInfo.write(yiSuf, p, this.yInfo.length-p, this.encoding);
	this.yInfo = bufferSlice.call(this.yInfo, 0, p);
	
	this.maxPostSize = y.maxSize(articleSize, this.line_size)
		+ (this.encryption ? 256 : 0)
		+ 75 /* size of fixed strings (incl final CRC) assuming ASCII or similar encoding */
		+ this.yInfo.length
		+ ((this.parts+'').length *2)
		+ ((size+'').length *3);
}
MultiEncoder.prototype = {
	headers: null,
	subjectPre: '', // default subject parameters
	subjectPost: '',
	messageIdFn: null,
	setHeaders: function(headers, defSubjectPre, defSubjectPost) {
		this.headers = {};
		this.messageIdFn = null;
		for(var h in headers) {
			var v = headers[h];
			var hl = h.toLowerCase();
			if(typeof v == 'function')
				this.headers[h] = v.bind(null, this.filename, this.size);
			else if(hl == 'subject' && v === null) {
				this.subjectPre = defSubjectPre.replace(RE_BADCHAR, '');
				this.subjectPost = defSubjectPost.replace(RE_BADCHAR, '');
				this.headers[h] = v;
			} else if(v)
				this.headers[h] = v.replace(RE_BADCHAR, '');
			else {
				if(hl == 'date' && this.timestamp)
					this.headers[h] = this.timestamp.toUTCString();
				else
					this.headers[h] = v;
			}
			
			// handle Message-ID header specially
			if(hl == 'message-id') {
				if(typeof v == 'function')
					this.messageIdFn = this.headers[h];
				else if(v) // a constant Message-ID isn't really sensical, but we'll allow it
					this.messageIdFn = (function() { return this; }).bind(v);
				delete this.headers[h];
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
		
		var wireData = data;
		var encryption = this.encryption;
		var encryptionResult;
		if(encryption) {
			loadCrypto();
			var aad = cryptoUtil.buildBodyAad(this.part, this.pos + 1, data.length, this.nameBytes);
			encryptionResult = cryptoUtil.encryptBody(data, encryption.key, encryption.segmentIndex, aad);
			wireData = encryptionResult.ciphertext;
		}
		var crc = y.crc32(wireData);
		var fullCrc = ' pcrc32=' + crc.toString('hex');
		this.crc = y.crc32_combine(this.crc, crc, wireData.length);
		if(this.part == this.parts) {
			// final part treated slightly differently
			if(end != this.size)
				throw new Error('File size doesn\'t match total data length');
			// whole-file CRC is of plaintext; ciphertext parts cannot match it
			if(!encryption) fullCrc += ' crc32='+this.crc.toString('hex');
		}
		
		var post = pool ? new PooledPost(this, pool) : new UnpooledPost(this);
		post.rawSize = data.length;
		if(this.messageIdFn)
			post.createMessageId = this.createMessageId.bind(this, this.part, this.parts);
		post.messageId = post.createMessageId(post);
		
		var headers = {};
		for(var h in this.headers) {
			var v = this.headers[h];
			var hl = h.toLowerCase();
			if(hl == 'subject' && v === null) {
				// default subject
				v = this.subjectPre + this.part + this.subjectPost;
			} else {
				if(typeof v == 'function') {
					v = v(this.part, this.parts, post);
					if(v === null || v === undefined) continue;
					if(typeof v == 'string')
						v = v.replace(RE_BADCHAR, '');
				}
				
				if(hl == 'date' && !v)
					v = (new Date(post.genTime)).toUTCString();
			}
			
			headers[h] = v;
			if(grabHeaders) grabHeaders[hl] = v;
		}
		post._setHeaders(headers);
		
		post._setData(wireData, this.part, this.pos, fullCrc, encryptionResult);
		if(encryption)
			post._postEncryptionFingerprint(data);
		
		this.pos = end;
		return post;
	},
	createMessageId: function(part, parts, post) {
		return (''+this.messageIdFn.call(post, part, parts, post)).replace(RE_BADMSGIDCHAR, '.');
	}
};

// pessimistic maximum size of an encoded article
// does not consider the effect of ENCODING, but assumes that it's sane
MultiEncoder.maxSize = function(size, line_size) {
	return 213 + MAX_NAME_LENGTH + y.maxSize(size, line_size);
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

MultiEncoder.fromBuffer = function(buf, encoding) {
	return new RawPost(buf, encoding);
};


function Post(parent) {
	this.parent = parent;
	this.genTime = parent.timestamp ? parent.timestamp.getTime() : Date.now();
}
Post.prototype = {
	genTime: null,
	rawSize: 0,
	// WARNING: do NOT return non-ASCII characters from this function!
	createMessageId: function(post) {
		var timestamp = ''+this.genTime;
		// fix the timestamp length to 13 chars - only an issue with wonky clocks
		timestamp = '0000000000000'.substring(timestamp.length) + timestamp.slice(-13);
		return String.fromCharCode(
			65 + Math.random()*26,
			97 + Math.random()*26,
			65 + Math.random()*26,
			97 + Math.random()*26,
			65 + Math.random()*26,
			97 + Math.random()*26,
			65 + Math.random()*26,
			97 + Math.random()*26,
			65 + Math.random()*26,
			97 + Math.random()*26,
			65 + Math.random()*26,
			97 + Math.random()*26,
			65 + Math.random()*26,
			97 + Math.random()*26,
			65 + Math.random()*26,
			97 + Math.random()*26,
			65 + Math.random()*26,
			97 + Math.random()*26,
			65 + Math.random()*26,
			97 + Math.random()*26,
			65 + Math.random()*26,
			97 + Math.random()*26,
			65 + Math.random()*26,
			97 + Math.random()*26
		) + '-' + timestamp + '@nyuu';
	},
	
	pos: null,
	part: null,
	crcFrag: null,
	data: null,
	postLen: null,
	postPos: 0,
	encryptionResult: null,
	
	reload: null, // overwrite this with a function defining how to reload the post into memory
	
	keepMessageId: false,
	_msgIdOffset: 13, /* 'Message-ID: <'.length */
	
	_setData: function(data, part, pos, crcFrag, encryptionResult) {
		this.part = part;
		this.pos = pos;
		this.crcFrag = crcFrag;
		this.inputLen = data.length;
		this.encryptionResult = encryptionResult || null;
		this.segmentIndex = this.parent.encryption ? this.parent.encryption.segmentIndex : null;
	},
	
	_postEncryptionFingerprint: function(data) {
		// Body Std v1.2 / UP7-1: retain a SHA-256 fingerprint of the original
		// plaintext so a later reread of changed source data is never encrypted
		// under the same key/nonce (which would leak plaintext XOR via
		// ciphertext XOR). The fingerprint survives releaseData and is never
		// replaced by a reload.
		this.plaintextFingerprint = crypto.createHash('sha256').update(data).digest();
	},
	
	_encryptForReload: function(data) {
		if(this.parent.encryption) {
			if(this.plaintextFingerprint) {
				var fp = crypto.createHash('sha256').update(data).digest();
				if(!fp.equals(this.plaintextFingerprint)) {
					// must not encrypt different bytes under the original nonce;
					// thrown synchronously so reloadData callers
					// never see an article built from changed source data
					var err = new Error('Source data changed since original encryption; refusing to re-encrypt under the original nonce');
					err.code = 'ENC_SOURCE_CHANGED';
					throw err;
				}
			}
			loadCrypto();
			var aad = cryptoUtil.buildBodyAad(this.part, this.pos + 1, data.length, this.parent.nameBytes);
			var encRes = cryptoUtil.encryptBody(data, this.parent.encryption.key, this.segmentIndex, aad);
			this.encryptionResult = encRes;
			return encRes.ciphertext;
		}
		return data;
	},
	
	randomizeMessageID: function() {
		var newId = this.createMessageId(this);
		// NOTE: this won't work if createMessageId returns non-ASCII characters; such cases are not supported
		if(newId.length > this.messageId.length)
			newId = newId.substring(0, this.messageId.length);
		else if(newId.length < this.messageId.length)
			newId = newId + '-' + this.messageId.substring(newId.length + 1).replace(/@/g, '-');
		this.data.write(newId, this._msgIdOffset, this.parent.encoding);
		return this.messageId = newId;
	},
	
	_getHeadersStr: function() {
		if(!this.data) return null;
		return bufferSlice.call(this.data, 0, this.postPos).toString(this.parent.encoding);
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
		to = Buffer.byteLength(headers.substring(from, to), this.parent.encoding);
		from = Buffer.byteLength(headers.substring(0, from), this.parent.encoding);
		to += from;
		
		// move data down in buffer
		this.data.copy(this.data, from, to);
		this.postPos -= to-from;
		this.data = bufferSlice.call(this.data, 0, this.postPos + this.postLen);
		
		return true;
	},
	
	releaseData: function() {
		this.release();
	},
	release: function() {
		this.data = null;
		this.encryptionResult = null;
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
		this.postPos = this.buf.write('Message-ID: <' + this.messageId + '>\r\n', 0, this.parent.encoding);
		for(var h in headers) {
			if(headers[h] === null || headers[h] === undefined) continue;
			this.postPos += this.buf.write(h + ': ' + headers[h] + '\r\n', this.postPos, this.parent.encoding);
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
function buildEncryptedBody(post, wireData) {
	var parent = post.parent;
	var enc = parent.encryption;
	var body = [
		toBuffer('=ybegin part=' + post.part, parent.encoding),
		parent.yInfo,
		toBuffer((post.pos + 1) + ' end=' + (post.pos + wireData.length) + '\r\n', parent.encoding),
		toBuffer('=yencryption cipher=XChaCha20-Poly1305 salt=' + enc.salt.toString('hex') + ' index=' + post.segmentIndex.toString(16).padStart(8, '0') + ' tag=' + post.encryptionResult.tag.toString('hex') + '\r\n', parent.encoding),
		y.encode(wireData, parent.line_size),
		toBuffer('\r\n=yend size=' + wireData.length + ' part=' + post.part + post.crcFrag + '\r\n.\r\n', parent.encoding)
	];
	var encoded = Buffer.concat(body);
	loadCrypto();
	encoded = ff1.encryptControlLines(encoded, enc.key, post.segmentIndex, enc.salt);
	return dotStuffEncryptedLines(encoded);
}

PooledPost.prototype._writeData = function(data) {
	if(this.parent.encryption) {
		var body = buildEncryptedBody(this, data);
		if(this.buf.length < this.postPos + body.length)
			this.buf = resizeBuffer(this.postPos + body.length, this.buf, this.postPos);
		body.copy(this.buf, this.postPos);
		this.data = bufferSlice.call(this.buf, 0, this.postPos + body.length);
		return body.length;
	}
	var bufPos = this.postPos;
	bufPos += this.buf.write('=ybegin part='+this.part, bufPos, this.parent.encoding);
	this.parent.yInfo.copy(this.buf, bufPos);
	bufPos += this.parent.yInfo.length;
	bufPos += this.buf.write(( this.pos+1 )+' end='+(this.pos + data.length)+'\r\n', bufPos, this.parent.encoding);
	bufPos += y.encodeTo(data, bufferSlice.call(this.buf, bufPos), this.parent.line_size);
	bufPos += this.buf.write('\r\n=yend size='+data.length+' part='+this.part+this.crcFrag+'\r\n.\r\n', bufPos, this.parent.encoding);
	
	this.data = bufferSlice.call(this.buf, 0, bufPos);
	return bufPos - this.postPos;
};
PooledPost.prototype._setData = function(data, part, pos, crcFrag, encryptionResult) {
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
	try {
		if(this.postPos != this.buf.write(this._headerStr, 0, this.parent.encoding))
			throw new Error('Header length mismatch encountered');
		var wireData = this._encryptForReload(data);
		if(this.postLen != this._writeData(wireData))
			throw new Error('Article length mismatch encountered');
	} catch(e) {
		// UP7-1: on a refused reread the borrowed buffer must be returned to
		// the pool exactly once; other exception paths keep upstream behavior
		if(e && e.code == 'ENC_SOURCE_CHANGED') {
			this.pool.put(this.buf);
			this.buf = null;
		}
		throw e;
	}
	
	this._headerStr = null;
};

function UnpooledPost(parent) {
	Post.call(this, parent);
}
UnpooledPost.prototype = Object.create(Post.prototype);
UnpooledPost.prototype.bufs = null;
UnpooledPost.prototype._addHeader = function(data) {
	var d = toBuffer(data + '\r\n', this.parent.encoding);
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
	if(this.parent.encryption) {
		var body = buildEncryptedBody(this, data);
		this.bufs.push(body);
		this.data = Buffer.concat(this.bufs);
		this.bufs = null;
		return this.data.length - this.postPos;
	}
	this.bufs.push(
		toBuffer('=ybegin part='+this.part, this.parent.encoding),
		this.parent.yInfo,
		toBuffer(( this.pos+1 )+' end='+(this.pos + data.length)+'\r\n', this.parent.encoding),
		y.encode(data, this.parent.line_size),
		toBuffer('\r\n=yend size='+data.length+' part='+this.part+this.crcFrag+'\r\n.\r\n', this.parent.encoding)
	);
	this.data = Buffer.concat(this.bufs);
	this.bufs = null;
	return this.data.length - this.postPos;
};
UnpooledPost.prototype._setData = function(data, part, pos, crcFrag, encryptionResult) {
	Post.prototype._setData.apply(this, arguments);
	
	this.postLen = this._writeData(data);
};
UnpooledPost.prototype._getHeadersStr = function() {
	if(!this.data && this.bufs && this.bufs.length == 1)
		return this.bufs[0].toString(this.parent.encoding);
	return Post.prototype._getHeadersStr.call(this);
};
UnpooledPost.prototype.releaseData = function() {
	this.bufs = [toBuffer(bufferSlice.call(this.data, 0, this.postPos))];
	this.release();
};
UnpooledPost.prototype.reloadData = function(data) {
	var wireData = this._encryptForReload(data);
	if(this.postLen != this._writeData(wireData))
		throw new Error('Article length mismatch encountered');
};


var bufferFind;
if(Buffer.prototype.indexOf)
	bufferFind = function(buf, search, encoding) {
		return buf.indexOf(search, encoding);
	};
else
	bufferFind = function(buf, search, encoding) {
		if(!Buffer.isBuffer(search))
			search = toBuffer(search, encoding);
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


// similar to Post, but constructed from a buffer
// TODO: consider making encoding 'binary' everywhere (can't do for now, due to messageId)
function RawPost(data, encoding) {
	var headers = {};
	
	this.data = this.buf = data;
	this.postPos = bufferFind(data, '\r\n\r\n', 'binary');
	if(this.postPos <= 0) throw new Error('Could not parse post');
	
	var hdr = bufferSlice.call(data, 0, this.postPos).toString(encoding).split('\r\n');
	this.postPos += 4; // '\r\n\r\n'.length
	
	var self = this;
	var p = 0;
	hdr.forEach(function(h) {
		var m = h.match(/^(.*?)(\: *)(.*)$/);
		if(!m || !m[1])
			throw new Error('Invalid header line: "' + h + '"');
		var k = m[1].trim().toLowerCase(),
		    v = m[3].trim();
		headers[k] = v;
		if(k == 'message-id') {
			self._msgIdOffset = p + Buffer.byteLength(m[1] + m[2], encoding);
		}
		p += Buffer.byteLength(h, encoding) + 2;
	});
	
	var m;
	if(!headers['message-id'] || !(m = headers['message-id'].match(/^<(.+)>$/)))
		throw new Error('Post lacks a valid Message-ID header!');
	// TODO: repair things if given a really short message ID (e.g. 3 bytes long)
	this.messageId = m[1];
	// TODO: above line can be problematic if non-ASCII characters received
	self._msgIdOffset++; // go past first <
	
	if(headers.date)
		this.genTime = (new Date(headers.date)).getTime();
	else
		this.genTime = Date.now();
	
	// TODO: set post.inputLen?
	
	this.data = this.buf;
	this.postLen = data.length - this.postPos;
	this.keepMessageId = true;
	this.parent = {encoding: encoding};
}
RawPost.prototype = Object.create(Post.prototype);

RawPost.prototype.reloadData = function(data) {
	this.data = data;
	if(this.postLen != data.length - this.postPos)
		throw new Error('Article length mismatch encountered');
};

module.exports = MultiEncoder;
