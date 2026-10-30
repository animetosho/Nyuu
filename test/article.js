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

it('encrypts body and control lines before yEnc encoding', function() {
	var key = Buffer.alloc(32, 7);
	var salt = Buffer.from('0102030405060708090b0c0e0f101112', 'hex');
	var a = new MultiEncoder('file', 6, 6, null, {
		encryption: {key: key, salt: salt, segmentIndex: 1}
	});
	a.setHeaders({});
	var post = a.generate(toBuffer('fixPln'));
	var wire = post.data.toString('binary');
	assert.equal(post.inputLen, 6);
	assert.equal(post.segmentIndex, 1);
	assert.equal(post.data.subarray(post.postPos, post.postPos + 16).toString('hex'), salt.toString('hex'));
	assert.equal(post.data.subarray(post.postPos + 16, post.postPos + 20).readUInt32BE(0), 1);
	assert.ok(wire.indexOf('=ybegin') < 0);
	assert.ok(wire.indexOf('=yencryption') < 0);
	assert.ok(post.postLen > post.postPos);
});

it('dot-stuffs encrypted control lines starting with a dot (forced 0x2E salt byte)', function() {
	var key = Buffer.alloc(32, 7);
	var salt = Buffer.from('2e02030405060708090b0c0e0f101112', 'hex');
	var a = new MultiEncoder('file', 6, 6, null, {
		encryption: {key: key, salt: salt, segmentIndex: 1}
	});
	a.setHeaders({});
	var post = a.generate(toBuffer('fixPln'));
	assert.equal(post.data[post.postPos], 0x2E, 'dot-stuffed extra dot');
	assert.equal(post.data[post.postPos + 1], 0x2E, 'original salt[0] dot');
	assert.equal(post.data.subarray(post.postPos + 1, post.postPos + 17).toString('hex'), salt.toString('hex'), 'intact salt bytes');
	assert.equal(post.data.subarray(post.postPos + 17, post.postPos + 21).readUInt32BE(0), 1, 'intact segment index');
	assert.ok(post.data.toString('ascii').endsWith('\r\n.\r\n'));
	assert.ok(!post.data.toString('ascii').endsWith('\r\n..\r\n'));
});

it('re-encrypts plaintext on reloadData without length mismatch or plaintext leak', function() {
	var key = Buffer.alloc(32, 7);
	var salt = Buffer.from('0102030405060708090b0c0e0f101112', 'hex');
	[null, new BufferPool(4096)].forEach(function(pool) {
		var a = new MultiEncoder('file', 500, 500, null, {
			encryption: {key: key, salt: salt, segmentIndex: 1}
		});
		a.setHeaders({});
		var plain = Buffer.alloc(500, 0);
		var post = a.generate(plain, pool);
		var oldData = Buffer.from(post.data);
		var oldTag = Buffer.from(post.encryptionResult.tag);
		post.releaseData();
		assert.equal(post.data, null);
		post.reloadData(plain);
		assert.ok(post.data);
		assert.equal(oldData.toString('hex'), post.data.toString('hex'));
		assert.equal(oldTag.toString('hex'), post.encryptionResult.tag.toString('hex'));
	});
});

it('refuses to re-encrypt changed source data under the original nonce and keeps the original fingerprint (UP7-1)', function() {
	var key = Buffer.alloc(32, 7);
	var salt = Buffer.from('0102030405060708090b0c0e0f101112', 'hex');
	[null, new BufferPool(4096)].forEach(function(pool) {
		var a = new MultiEncoder('file', 5, 5, null, {
			encryption: {key: key, salt: salt, segmentIndex: 1}
		});
		a.setHeaders({});
		var post = a.generate(toBuffer('AAAAA'), pool);
		var oldTag = Buffer.from(post.encryptionResult.tag);
		var oldCipher = Buffer.from(post.encryptionResult.ciphertext);
		post.releaseData();
		assert.throws(function() {
			post.reloadData(toBuffer('BBBBB'));
		}, function(e) {
			return e instanceof Error && e.code == 'ENC_SOURCE_CHANGED';
		}, 'reload of changed source must be refused');
		if(pool) {
			// the borrowed reload buffer must be returned to the pool exactly once
			assert.equal(pool.pool.filter(function(b) { return b.length === 4096; }).length >= 1, true, 'borrowed buffer returned to pool');
		}
		// the original fingerprint must never be replaced, even after a rejected reread
		post.reloadData(toBuffer('AAAAA'));
		assert.equal(post.encryptionResult.tag.toString('hex'), oldTag.toString('hex'));
		assert.equal(post.encryptionResult.ciphertext.toString('hex'), oldCipher.toString('hex'));
	});
});

it('refuses a changed-source reload after evicted cache identity is gone but still reloads unchanged source (UP7-1, multi-part)', function() {
	var key = Buffer.alloc(32, 7);
	var salt = Buffer.from('0102030405060708090b0c0e0f101112', 'hex');
	var cryptoUtil = require('../lib/crypto');
	[null, new BufferPool(4096)].forEach(function(pool) {
		var encContext = {key: key, salt: salt, segmentIndex: 7};
		var a = new MultiEncoder('file', 8, 4, null, {
			encryption: encContext
		});
		a.setHeaders({});
		var p1 = a.generate(toBuffer('AAAA'), pool);
		encContext.segmentIndex = cryptoUtil.nextSafeSegmentIndex(encContext.segmentIndex);
		var p2 = a.generate(toBuffer('BBBB'), pool);
		assert.notEqual(p1.segmentIndex, p2.segmentIndex);
		var tag1 = Buffer.from(p1.encryptionResult.tag);
		var cipher1 = Buffer.from(p1.encryptionResult.ciphertext);
		p1.releaseData();
		p2.releaseData();
		assert.throws(function() { p1.reloadData(toBuffer('AAAB')); }, /nonce/);
		assert.throws(function() { p2.reloadData(toBuffer('BBBA')); }, /nonce/);
		// unchanged rereads still reload byte-identically
		p1.reloadData(toBuffer('AAAA'));
		assert.equal(p1.encryptionResult.tag.toString('hex'), tag1.toString('hex'));
		assert.equal(p1.encryptionResult.ciphertext.toString('hex'), cipher1.toString('hex'));
	});
});

it('ordinary (unencrypted) reloadData of changed source bytes is unchanged (UP7-1 control)', function() {
	var a = new MultiEncoder('file', 5, 5, null, {});
	a.setHeaders({});
	var post = a.generate(toBuffer('AAAAA'));
	var oldData = Buffer.from(post.data);
	post.releaseData();
	// without encryption a changed reread must still be accepted (upstream behavior)
	post.reloadData(toBuffer('BBBBB'));
	assert.notEqual(post.data.toString('hex'), oldData.toString('hex'));
});

it('clears complete encryptionResult on releaseData and release for pooled and unpooled posts (NY-NEXT-1)', function() {
	var key = Buffer.alloc(32, 7);
	var salt = Buffer.from('0102030405060708090b0c0e0f101112', 'hex');
	[null, new BufferPool(4096)].forEach(function(pool) {
		var a = new MultiEncoder('file', 768000, 768000, null, {
			encryption: {key: key, salt: salt, segmentIndex: 1}
		});
		a.setHeaders({});
		var plain = Buffer.alloc(768000, 0x42);
		var post = a.generate(plain, pool);
		assert.ok(post.encryptionResult);
		assert.ok(post.encryptionResult.ciphertext);
		assert.strictEqual(post.encryptionResult.ciphertext.length, 768000);
		assert.strictEqual(post.encryptionResult.tag.length, 16);
		// Ciphertext and tag share the same underlying sealed allocation
		assert.strictEqual(post.encryptionResult.ciphertext.buffer, post.encryptionResult.tag.buffer);

		post.releaseData();
		assert.strictEqual(post.data === null, true, 'data must be null after releaseData');
		assert.strictEqual(post.encryptionResult === null, true, 'encryptionResult must be cleared on releaseData');

		post.reloadData(plain);
		assert.ok(post.data);
		assert.ok(post.encryptionResult);

		post.release();
		assert.strictEqual(post.data === null, true, 'data must be null after final release');
		assert.strictEqual(post.encryptionResult === null, true, 'encryptionResult must be cleared on final release');
	});
});

it('check-cache eviction clears complete encryptionResult, preserves identity, and allows reloading evicted post (NY-NEXT-1)', function() {
	var CacheMgr = require('../lib/cachehelper');
	var cryptoUtil = require('../lib/crypto');
	var key = Buffer.alloc(32, 7);
	var salt = Buffer.from('0102030405060708090b0c0e0f101112', 'hex');

	[null, new BufferPool(4096)].forEach(function(pool) {
		var evictedPosts = [];
		var checkCache = new CacheMgr(function(post) {
			post.releaseData();
			evictedPosts.push(post);
		}, 5);

		var numParts = 50;
		var partSize = 1000;
		var totalSize = numParts * partSize;
		var encContext = {key: key, salt: salt, segmentIndex: 1};
		var a = new MultiEncoder('testfile.bin', totalSize, partSize, null, {
			encryption: encContext
		});
		a.setHeaders({});

		// Generate part 1
		var plain1 = Buffer.alloc(partSize, 0x11);
		var post1 = a.generate(plain1, pool);
		var wire1 = Buffer.from(post1.data);
		var tag1 = Buffer.from(post1.encryptionResult.tag);
		var index1 = post1.segmentIndex;
		var msgId1 = post1.messageId;

		var post1Id;
		checkCache.add(post1, true, function(id) { post1Id = id; });
		// Evict post 1 from checkCache
		checkCache.evict(post1Id);
		assert.strictEqual(post1.data === null, true);
		assert.strictEqual(post1.encryptionResult === null, true);

		// Generate subsequent parts 2..50, updating encoder's segmentIndex
		for(var p = 2; p <= numParts; p++) {
			encContext.segmentIndex = cryptoUtil.nextSafeSegmentIndex(encContext.segmentIndex);
			var plainP = Buffer.alloc(partSize, p & 0xff);
			var postP = a.generate(plainP, pool);
			checkCache.add(postP, true);
		}

		// Cache size is 5, so at least 45 posts must have been evicted
		assert.ok(evictedPosts.length >= 45, 'expected >= 45 evicted posts, got ' + evictedPosts.length);

		// Verify all evicted posts retain no data and no encryptionResult (no ciphertext or tag)
		evictedPosts.forEach(function(evicted, idx) {
			assert.strictEqual(evicted.data === null, true, 'evicted post ' + idx + ' data must be null');
			assert.strictEqual(evicted.encryptionResult === null, true, 'evicted post ' + idx + ' encryptionResult must be null');
		});

		// Reload post 1 and verify complete identity preserved
		post1.reloadData(plain1);
		assert.ok(post1.data);
		assert.strictEqual(post1.data.toString('hex'), wire1.toString('hex'), 'wire data must match after reload');
		assert.strictEqual(post1.encryptionResult.tag.toString('hex'), tag1.toString('hex'), 'tag must match after reload');
		assert.strictEqual(post1.segmentIndex, index1, 'segmentIndex must match after reload');
		assert.strictEqual(post1.messageId, msgId1, 'messageId must match after reload');

		// Final release of post 1 clears all retained allocations
		post1.release();
		assert.strictEqual(post1.data === null, true);
		assert.strictEqual(post1.encryptionResult === null, true);
	});
});

it('pooled post grows undersized pooled buffer on reloadData instead of silently truncating article', function() {
	var key = Buffer.alloc(32, 7);
	var salt = Buffer.from('0102030405060708090b0c0e0f101112', 'hex');
	// build an oversized post once to learn its exact wire length
	var a = new MultiEncoder('f', 600, 600, null, {
		encryption: {key: key, salt: salt, segmentIndex: 1}
	});
	a.setHeaders({});
	var reference = a.generate(Buffer.alloc(600));
	var expectedLen = reference.postPos + reference.postLen;

	// reload path hands the post a pooled buffer that is smaller than the body:
	// the post must be grown, never silently clipped by Buffer.copy
	var tinyPool = new BufferPool(expectedLen - 100);
	tinyPool.put(Buffer.alloc(expectedLen - 100));
	var a2 = new MultiEncoder('f', 600, 600, null, {
		encryption: {key: key, salt: salt, segmentIndex: 1}
	});
	a2.setHeaders({});
	var post = a2.generate(Buffer.alloc(600), tinyPool);
	var goodData = Buffer.from(post.data);
	post.releaseData();
	// ensure the pool hands back an undersized buffer on reload
	tinyPool.pool = [Buffer.alloc(expectedLen - 100)];
	post.reloadData(Buffer.alloc(600));
	assert.equal(post.data.length, expectedLen);
	assert.equal(post.data.toString('hex'), goodData.toString('hex'));
	// the full body must be intact: final yend terminator present at the very end
	assert(post.data.toString('ascii').endsWith('\r\n.\r\n'));
	// control lines are encrypted: no plaintext =yencryption header on the wire
	assert.doesNotMatch(post.data.toString('ascii'), /=yencryption/);
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

it('long multibyte name unencrypted matches upstream', function() {
	var longName = 'a'.repeat(1023) + '🔑.bin';
	var yiPre = ' total=1 line=128 size=10 name=', yiSuf = '\r\n=ypart begin=';
	var expectedYInfo = (Buffer.allocUnsafe || Buffer)(Buffer.byteLength(yiPre + yiSuf, 'utf8') + 1024);
	var p = expectedYInfo.write(yiPre, 0, expectedYInfo.length, 'utf8');
	p += expectedYInfo.write(longName, p, 1024, 'utf8');
	p += expectedYInfo.write(yiSuf, p, expectedYInfo.length - p, 'utf8');
	expectedYInfo = bufferSlice.call(expectedYInfo, 0, p);

	var a = new MultiEncoder(longName, 10, 10);
	assert.equal(a.yInfo.toString('binary'), expectedYInfo.toString('binary'));
});

it('long multibyte name encrypted is valid UTF-8 and equals AAD name', function() {
	var key = Buffer.alloc(32, 7);
	var salt = Buffer.from('0102030405060708090b0c0e0f101112', 'hex');
	var longName = 'a'.repeat(1023) + '🔑.bin';
	var a = new MultiEncoder(longName, 10, 10, null, {
		encryption: {key: key, salt: salt, segmentIndex: 1}
	});
	assert.ok(Buffer.isBuffer(a.nameBytes));
	assert.equal(a.nameBytes.length, 1023);
	assert.equal(a.nameBytes.toString('utf8'), 'a'.repeat(1023));
	assert.ok(a.yInfo.toString('binary').indexOf(' name=' + a.nameBytes.toString('binary') + '\r\n') >= 0);

	a.setHeaders({});
	var post = a.generate(toBuffer('0123456789'));
	assert.ok(post.encryptionResult);
	assert.ok(post.encryptionResult.ciphertext);
});

// TODO: test Post.* stuff?
// TODO: check message IDs
// TODO: test raw posts

});
