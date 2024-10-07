"use strict";

var assert = require("assert");

var MultiEncoder = require('../lib/article');
var BufferPool = require('../lib/bufferpool');
var bufferSlice = Buffer.prototype.readBigInt64BE ? Buffer.prototype.subarray : Buffer.prototype.slice;
var toBuffer = (Buffer.alloc ? Buffer.from : Buffer);

describe('Article', function() {

// TODO: test case of header exceeding line length??

var simpleCheck = function(pool) {
	var a = new MultiEncoder('some\nfile', 6, 3);
	assert.equal(a.filename, 'some\nfile');
	assert.ok(a.line_size);
	
	var s;
	
	a.setHeaders({
		Subject: 'first post!',
		From: function(filename, filesize, part, parts, post) {
			assert.equal(filename, 'some\nfile');
			assert.equal(filesize, 6);
			assert.equal(part, 1);
			assert.equal(parts, 2);
			assert.equal(post.rawSize, 3);
			return 'fromfield';
		}
	});
	var a1Headers = {};
	var a1 = a.generate(toBuffer('abc'), pool, a1Headers);
	assert.equal(a1.part, 1);
	s = a1.data.toString();
	
	var headers = bufferSlice.call(a1.data, 0, a1.postPos).toString();
	
	// first part should not have a crc32 (but may have a pcrc32)
	assert(!s.match(/[^p]crc32=/));
	assert(s.match(/name=somefile/));
	assert.notEqual(headers.indexOf('first post!'), -1);
	assert.equal(a1Headers.subject, 'first post!');
	assert.notEqual(headers.indexOf('fromfield'), -1);
	assert.equal(a1Headers.from, 'fromfield');
	
	// TODO: consider parsing data and checking everything
	
	a.setHeaders({
		'X-Test': '',
		'Message-ID': function(filename, filesize, part, parts, post) {
			assert.equal(filename, 'some\nfile');
			assert.equal(filesize, 6);
			assert.equal(part, 2);
			assert.equal(parts, 2);
			assert.equal(post.rawSize, 3);
			return 'test\u0080msgid';
		},
		missing: function() { return null; }
	});
	var a2Headers = {};
	var a2 = a.generate(toBuffer('def'), pool, a2Headers);
	assert.equal(a2.part, 2);
	s = a2.data.toString();
	headers = bufferSlice.call(a2.data, 0, a2.postPos).toString();
	
	// check a2 has a crc32
	assert.notEqual(s.indexOf('crc32='), -1);
	assert.notEqual(headers.indexOf('X-Test:'), -1);
	assert.equal(a2Headers['x-test'], '');
	assert(!a2Headers.subject); // since we didn't supply one
	assert(!('missing' in a2Headers));
	assert.equal(a2.messageId, 'test.msgid'); // Unicode character should be replaced
	
	assert.equal(a.pos, 6);
	
	// test release+reload
	var oldData = toBuffer(a1.data);
	a1.releaseData();
	a1.reloadData(toBuffer('abc'));
	assert.equal(oldData.toString('hex'), a1.data.toString('hex'));
	
	oldData = toBuffer(a2.data);
	a2.releaseData();
	a2.reloadData(toBuffer('def'));
	assert.equal(oldData.toString('hex'), a2.data.toString('hex'));
};

it('basic unpooled post test', function(done) {
	simpleCheck();
	done();
});
it('basic (small) pooled post test', function(done) {
	simpleCheck(new BufferPool(1));
	done();
});
it('basic (large) pooled post test', function(done) {
	simpleCheck(new BufferPool(4096));
	done();
});

it('empty file test', function(done) {
	var a = new MultiEncoder('file', 0, 1);
	assert.equal(a.parts, 1);
	assert.equal(a.size, 0);
	a.setHeaders({});
	var a1 = a.generate(toBuffer(''));
	
	assert.equal(a1.part, 1);
	assert.equal(a1.inputLen, 0);
	var postData = a1.data.toString();
	assert.notEqual(postData.indexOf(' crc32=00000000'), -1);
	assert.notEqual(postData.indexOf(' pcrc32=00000000'), -1);
	assert.notEqual(postData.indexOf(' size=0 '), -1);
	
	done();
});

it('should throw if sent too many parts', function(done) {
	var a = new MultiEncoder('file', 6, 6);
	a.setHeaders({});
	var a1 = a.generate(toBuffer('aabbcc'));
	
	assert.equal(a1.part, 1);
	assert.notEqual(a1.data.toString().indexOf('crc32='), -1);
	
	assert.throws(function() {
		a.generate(toBuffer('b'));
	}, Error);
	done();
});
it('should throw if sent too much data', function(done) {
	var a = new MultiEncoder('file', 3, 2);
	a.setHeaders({});
	a.generate(toBuffer('aa'));
	assert.throws(function() {
		a.generate(toBuffer('bb'));
	}, Error);
	done();
});
it('should throw if sent data isn\'t expected amount', function(done) {
	var a = new MultiEncoder('file', 5, 3);
	a.setHeaders({});
	a.generate(toBuffer('aa'));
	assert.throws(function() {
		a.generate(toBuffer('bb'));
	}, Error);
	done();
});

// TODO: test Post.* stuff?
// TODO: check message IDs
// TODO: test raw posts

});
