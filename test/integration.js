"use strict";

var assert = require("assert");
var Readable = require('stream').Readable;
var ArticleEncoder = require('../lib/article');
var NZBGenerator = require('../lib/nzb');
var cryptoUtil = require('../lib/crypto');
var config = require('../config');
var fileuploader = require('../lib/fileuploader');

// In-memory transport sink: replaces only the final network queue
// (`lib/uploader`). fileuploader, UploadManager, stream readers, the
// segment-index allocator, article encoder, KDF and AEAD remain production
// code. No socket is opened.
function makeOfflineSink(captures) {
	function OfflineSink(opts, cb) { this.done = cb; }
	OfflineSink.prototype.addPost = function(post, readCb, postedCb) {
		captures.push({
			salt: post.parent.encryption ? Buffer.from(post.parent.encryption.salt) : null,
			key: post.parent.encryption ? Buffer.from(post.parent.encryption.key) : null,
			index: post.segmentIndex,
			ciphertext: post.encryptionResult ? Buffer.from(post.encryptionResult.ciphertext) : null,
			tag: post.encryptionResult ? Buffer.from(post.encryptionResult.tag) : null,
			data: Buffer.from(post.data)
		});
		postedCb(null);
		readCb(null);
	};
	OfflineSink.prototype.finished = function() { this.done(null); };
	OfflineSink.prototype.cancel = function(err) { this.done(err); };
	OfflineSink.setLogger = function() {};
	return OfflineSink;
}

// Installs a fresh OfflineSink as `lib/uploader` for the current test.
// `lib/uploadmgr` captures the Uploader constructor when it is first
// loaded, so the fileuploader -> uploadmgr -> uploader chain is
// re-required with the sink already in place. Returns a cleanup function
// that restores the original module entries.
function installOfflineSink(captures) {
	var paths = [
		require.resolve('../lib/fileuploader'),
		require.resolve('../lib/uploadmgr'),
		require.resolve('../lib/uploader')
	];
	var saved = paths.map(function(p) { return require.cache[p]; });
	var uploaderPath = require.resolve('../lib/uploader');
	paths.forEach(function(p) { delete require.cache[p]; });
	require.cache[uploaderPath] = {
		id: uploaderPath,
		filename: uploaderPath,
		loaded: true,
		exports: makeOfflineSink(captures)
	};
	fileuploader = require('../lib/fileuploader');
	return function() {
		paths.forEach(function(p, i) {
			if(saved[i]) require.cache[p] = saved[i];
			else delete require.cache[p];
		});
		fileuploader = require('../lib/fileuploader');
	};
}

// Writable stream sink that captures the emitted NZB XML.
function makeXmlCapture(capturesOut) {
	var chunks = [];
	capturesOut.push(chunks);
	return {
		writable: true,
		write: function(c) { chunks.push(Buffer.from(c)); return true; },
		end: function(cb) { if(cb) cb(); }
	};
}

function makeStream(name, text) {
	return [{name: name, size: text.length, stream: Readable.from([Buffer.from(text)])}];
}

function baseOpts(over) {
	return Object.assign({}, config, {
		encryptionEnabled: true,
		encryptionPassword: 'conformance-fixture-password',
		useBufferPool: false,
		check: {},
		articleSize: 32,
		diskBufferSize: 1,
		postHeaders: {From: 'test@example.test', Newsgroups: 'alt.test'}
	}, over);
}

function startUpload(files, opts) {
	return new Promise(function(resolve, reject) {
		fileuploader.upload(files, opts, function(err) {
			if(err) reject(err); else resolve();
		});
	});
}

describe('Encrypted upload pipeline', function() {
	var cleanup = null;
	afterEach(function() {
		if(cleanup) {
			cleanup();
			cleanup = null;
		}
	});

	it('verifies combined default encryption with Line 1 bootstrap prefix and dual-bootstrap agreement', function() {
		var output = [];
		var nzb = new NZBGenerator({yenc_encrypted: 'true', password: 'conformance-fixture-password'}, function(value, encoding) {
			output.push(Buffer.from(value, encoding));
		}, true, 'utf8');
		var salt = Buffer.from('0102030405060708090b0c0e0f101112', 'hex');
		var key = Buffer.alloc(32, 7);
		var segmentIndex = 1;

		var encoder = new ArticleEncoder('file.bin', 5, 5, null, {
			encryption: {
				key: key,
				salt: salt,
				segmentIndex: segmentIndex
			}
		});
		encoder.setHeaders({}, '', '');
		var post = encoder.generate(Buffer.from('hello'));
		// the whole-file CRC is of plaintext, so the final ciphertext part omits it
		assert.notEqual(post.crcFrag.indexOf(' pcrc32='), -1);
		assert.equal(post.crcFrag.indexOf(' crc32='), -1);
		nzb.file('file.bin (1/1)', 'poster', ['alt.test'], 1);
		nzb.addSegment(post.postLen, 'article@example.com');
		nzb.end();

		var wire = post.data.toString('binary');
		var xml = Buffer.concat(output).toString('utf8');

		// 1. Line 1 20-byte bootstrap prefix
		var line1Prefix = post.data.subarray(post.postPos, post.postPos + 20);
		var prefixSalt = line1Prefix.subarray(0, 16);
		var prefixSegmentIndex = line1Prefix.readUInt32BE(16);
		assert.equal(prefixSalt.toString('hex'), salt.toString('hex'));
		assert.equal(prefixSegmentIndex, segmentIndex);

		// 2. Control lines and body payload are encrypted (no plaintext on wire)
		assert.ok(wire.indexOf('=ybegin') < 0);
		assert.ok(wire.indexOf('=yencryption') < 0);
		assert.ok(wire.indexOf('hello') < 0);

		// 3. Dual-bootstrap agreement between Line 1 prefix and =yencryption header:
		// the (encrypted) =yencryption line is the third control line, and FF1
		// preserves line lengths, so it must be exactly 128 chars (the canonical
		// five-token line) and Line 1 must carry the same salt/index asserted in 1.
		var expectedYencLine = '=yencryption cipher=XChaCha20-Poly1305 salt=' + prefixSalt.toString('hex') +
			' index=' + prefixSegmentIndex.toString(16).padStart(8, '0') +
			' tag=' + post.encryptionResult.tag.toString('hex');
		assert.equal(expectedYencLine.length, 128);

		var bodyBuf = post.data.subarray(post.postPos);
		var lines = [];
		var start = 0;
		for(var i = 0; i < bodyBuf.length; i++) {
			if(bodyBuf[i] === 10) {
				var end = (i > start && bodyBuf[i - 1] === 13) ? i - 1 : i;
				lines.push(bodyBuf.subarray(start, end));
				start = i + 1;
			}
		}
		assert.equal(lines[2].length, 128);

		// 4. NZB metadata and plain NZB 1.1 segment assertions
		assert.match(xml, /meta type="yenc_encrypted">true/);
		assert.match(xml, /meta type="password">conformance-fixture-password/);
		var segmentTags = xml.match(/<segment [^>]*>/g) || [];
		assert.equal(segmentTags.length, 1);
		segmentTags.forEach(function(tag) {
			assert.match(tag, /^<segment bytes="\d+" number="\d+">$/);
		});
	});

	it('sets encryption metadata when opts.nzb is a factory function', function() {
		var captures = [];
		cleanup = installOfflineSink(captures);
		var xmlOutputs = [];
		var createdNzbOpts = null;
		var nzbFactory = function() {
			createdNzbOpts = {
				writeTo: function() { return makeXmlCapture(xmlOutputs); },
				metaData: {}
			};
			return ['custom_nzb', createdNzbOpts];
		};
		var opts = baseOpts({
			encryptionEnabled: true,
			encryptionPassword: 'conformance-fixture-password',
			nzb: nzbFactory
		});
		return startUpload(makeStream('file.bin', 'hello'), opts).then(function() {
			// caller factory identity is unchanged
			assert.strictEqual(opts.nzb, nzbFactory);
			// caller factory metadata is not mutated
			assert.deepStrictEqual(createdNzbOpts.metaData, {});
			assert.strictEqual(opts.encryption, undefined);
			// emitted NZB XML has the required metadata
			assert.equal(xmlOutputs.length, 1);
			var xml = Buffer.concat(xmlOutputs[0]).toString('utf8');
			assert.match(xml, /<meta type="yenc_encrypted">true<\/meta>/);
			assert.match(xml, /<meta type="password">conformance-fixture-password<\/meta>/);
		});
	});

	it('overrides a user-supplied false yenc_encrypted marker when encryption is enabled', function() {
		var captures = [];
		cleanup = installOfflineSink(captures);
		var xmlOutputs = [];
		var callerMeta = {
			yenc_encrypted: 'false'
		};
		var opts = baseOpts({
			encryptionEnabled: true,
			encryptionPassword: 'conformance-fixture-password',
			nzb: {
				writeTo: function() { return makeXmlCapture(xmlOutputs); },
				metaData: callerMeta
			}
		});
		return startUpload(makeStream('file.bin', 'hello'), opts).then(function() {
			// caller's metaData must not be mutated
			assert.equal(callerMeta.yenc_encrypted, 'false');
			assert.strictEqual(opts.encryption, undefined);
			// emitted NZB XML carries the authoritative marker and password
			assert.equal(xmlOutputs.length, 1);
			var xml = Buffer.concat(xmlOutputs[0]).toString('utf8');
			assert.match(xml, /<meta type="yenc_encrypted">true<\/meta>/);
			assert.ok(xml.indexOf('yenc_encrypted">false') < 0, 'contradictory false marker must not appear');
			assert.equal(xml.match(/yenc_encrypted/g).length, 1);
			assert.match(xml, /<meta type="password">conformance-fixture-password<\/meta>/);
		});
	});

	// Body Std §8 (v1.2): yenc_version/yenc_cipher are OPTIONAL metadata that
	// producers may emit, but only with the exact canonical values ("1.2" /
	// "XChaCha20-Poly1305"). A receiver that consumes them MUST treat any other
	// value (including empty) as a METADATA_VALIDATION failure. Nyuu emits
	// neither entry, so a user-supplied conflicting value must be deleted from
	// the emitted NZB (not overwritten), and the caller's object must be untouched.
	it('deletes conflicting yenc_version and yenc_cipher metas when encryption is enabled (object form)', function() {
		var captures = [];
		cleanup = installOfflineSink(captures);
		var xmlOutputs = [];
		var callerMeta = {
			yenc_version: '0.3',
			yenc_cipher: ''
		};
		var opts = baseOpts({
			encryptionEnabled: true,
			encryptionPassword: 'conformance-fixture-password',
			nzb: {
				writeTo: function() { return makeXmlCapture(xmlOutputs); },
				metaData: callerMeta
			}
		});
		return startUpload(makeStream('file.bin', 'hello'), opts).then(function() {
			// caller's metaData must not be mutated
			assert.equal(callerMeta.yenc_version, '0.3');
			assert.equal(callerMeta.yenc_cipher, '');
			// emitted NZB XML: required metadata present, conflicting optional
			// metadata absent entirely
			assert.equal(xmlOutputs.length, 1);
			var xml = Buffer.concat(xmlOutputs[0]).toString('utf8');
			assert.match(xml, /<meta type="yenc_encrypted">true<\/meta>/);
			assert.match(xml, /<meta type="password">conformance-fixture-password<\/meta>/);
			assert.ok(xml.indexOf('yenc_version') < 0, 'conflicting yenc_version must not appear in emitted XML');
			assert.ok(xml.indexOf('yenc_cipher') < 0, 'conflicting yenc_cipher must not appear in emitted XML');
		});
	});

	it('deletes conflicting yenc_version and yenc_cipher metas when encryption is enabled (factory form)', function() {
		var captures = [];
		cleanup = installOfflineSink(captures);
		var xmlOutputs = [];
		var callerMeta;
		var nzbFactory = function() {
			callerMeta = {
				yenc_version: '0.3',
				yenc_cipher: ''
			};
			return ['custom_nzb', {
				writeTo: function() { return makeXmlCapture(xmlOutputs); },
				metaData: callerMeta
			}];
		};
		var opts = baseOpts({
			encryptionEnabled: true,
			encryptionPassword: 'conformance-fixture-password',
			nzb: nzbFactory
		});
		return startUpload(makeStream('file.bin', 'hello'), opts).then(function() {
			// caller factory's metadata is not mutated
			assert.equal(callerMeta.yenc_version, '0.3');
			assert.equal(callerMeta.yenc_cipher, '');
			// emitted NZB XML: required metadata present, conflicting optional
			// metadata absent entirely
			assert.equal(xmlOutputs.length, 1);
			var xml = Buffer.concat(xmlOutputs[0]).toString('utf8');
			assert.match(xml, /<meta type="yenc_encrypted">true<\/meta>/);
			assert.match(xml, /<meta type="password">conformance-fixture-password<\/meta>/);
			assert.ok(xml.indexOf('yenc_version') < 0, 'conflicting yenc_version must not appear in emitted XML');
			assert.ok(xml.indexOf('yenc_cipher') < 0, 'conflicting yenc_cipher must not appear in emitted XML');
		});
	});

	it('leaves yenc_version and yenc_cipher untouched when encryption is disabled', function() {
		var captures = [];
		cleanup = installOfflineSink(captures);
		var xmlOutputs = [];
		var callerMeta = {
			yenc_version: '0.3',
			yenc_cipher: ''
		};
		var opts = baseOpts({
			encryptionEnabled: false,
			nzb: {
				writeTo: function() { return makeXmlCapture(xmlOutputs); },
				metaData: callerMeta
			}
		});
		return startUpload(makeStream('file.bin', 'hello'), opts).then(function() {
			assert.equal(xmlOutputs.length, 1);
			var xml = Buffer.concat(xmlOutputs[0]).toString('utf8');
			assert.match(xml, /<meta type="yenc_version">0.3<\/meta>/);
			assert.match(xml, /<meta type="yenc_cipher"><\/meta>/);
			assert.ok(xml.indexOf('yenc_encrypted') < 0);
		});
	});

	it('encryption password overwrites archive password without error when both are set', function() {
		var captures = [];
		cleanup = installOfflineSink(captures);
		var xmlOutputs = [];
		var callerMeta = {
			password: 'fixture-archive-value'
		};
		var opts = baseOpts({
			encryptionEnabled: true,
			encryptionPassword: 'fixture-transport-value',
			nzb: {
				writeTo: function() { return makeXmlCapture(xmlOutputs); },
				metaData: callerMeta
			}
		});
		return startUpload(makeStream('file.bin', 'hello'), opts).then(function() {
			// caller's metaData must not be mutated
			assert.equal(callerMeta.password, 'fixture-archive-value');
			assert.equal(callerMeta.yenc_encrypted, undefined);
			assert.strictEqual(opts.encryption, undefined);
			// emitted NZB XML: encryption password is authoritative
			assert.equal(xmlOutputs.length, 1);
			var xml = Buffer.concat(xmlOutputs[0]).toString('utf8');
			assert.match(xml, /<meta type="yenc_encrypted">true<\/meta>/);
			assert.match(xml, /<meta type="password">fixture-transport-value<\/meta>/);
			assert.ok(xml.indexOf('fixture-archive-value') < 0, 'archive password must not appear in generated XML');
			assert.equal(xml.match(/<meta type="password">/g).length, 1);
		});
	});

	describe('wire-level decryption of a pipeline article (NY12-04)', function() {
		this.timeout(30000);

		it('FF1-restores, verifies dual-bootstrap agreement, AEAD-decrypts to the source bytes, and NZB segment bytes equals plaintext length', function() {
			var captures = [];
			cleanup = installOfflineSink(captures);
			var xmlOutputs = [];
			var ff1Decrypt = require('./_ff1decrypt');
			var y = require('yencode');
			var xchacha20poly1305 = require('@noble/ciphers/chacha').xchacha20poly1305;
			// ~200 bytes over articleSize 32 => multiple encrypted segments
			var source = Buffer.alloc(200);
			for(var i = 0; i < source.length; i++) source[i] = (i * 37 + 11) & 0xff;
			var opts = baseOpts({
				nzb: {
					writeTo: function() { return makeXmlCapture(xmlOutputs); },
					metaData: {}
				}
			});
			var streamFile = [{name: 'wire.bin', size: source.length, stream: Readable.from([source])}];
			return startUpload(streamFile, opts).then(function() {
				assert.ok(captures.length > 1, 'expected a multi-segment upload');
				var key = captures[0].key;
				var plaintextByIndex = {};
				captures.forEach(function(cap) {
					// article body = bytes after the NNTP header blank line
					var headerEnd = cap.data.indexOf('\r\n\r\n');
					assert.ok(headerEnd >= 0, 'article headers present');
					var wireBody = cap.data.subarray(headerEnd + 4);
					// dot-unstuff (RFC 3977) and drop the ".\r\n" terminator
					var terminator = wireBody.lastIndexOf('\r\n.\r\n');
					assert.ok(terminator >= 0, 'article terminator present');
					var unstuffed = Buffer.from(wireBody.subarray(0, terminator + 2).toString('binary').replace(/\r\n\./g, '\r\n'), 'binary');
					assert.ok(unstuffed.indexOf('=ybegin') < 0, 'no plaintext control lines on the wire');
					// FF1-restore the control lines; Line 1 carries the bootstrap
					var restored = ff1Decrypt.decryptControlLines(unstuffed, key);
					var bootSalt = restored.salt;
					var bootIndex = restored.segmentIndex;
					assert.ok(bootSalt.equals(cap.salt), 'bootstrap salt matches the upload salt');
					assert.equal(bootIndex, cap.index, 'bootstrap index matches the allocated segment index');
					var text = restored.block.toString('binary');
					var lines = text.split('\r\n');
					assert.ok(lines[0].indexOf('=ybegin ') === 0, 'restored Line 1 is =ybegin: ' + lines[0]);
					// locate the restored =yencryption line and check agreement
					var yencLine = null, ypartLine = null;
					lines.forEach(function(l) {
						if(l.indexOf('=yencryption ') === 0) yencLine = l;
						if(l.indexOf('=ypart ') === 0) ypartLine = l;
					});
					assert.ok(yencLine, 'restored =yencryption line present');
					assert.equal(yencLine.length, 128, '=yencryption line is exactly 128 chars');
					var m = yencLine.match(/^=yencryption cipher=XChaCha20-Poly1305 salt=([0-9a-f]{32}) index=([0-9a-f]{8}) tag=([0-9a-f]{32})$/);
					assert.ok(m, '=yencryption grammar: ' + yencLine);
					// Line-1 bootstrap == =yencryption salt/index agreement
					assert.equal(m[1], bootSalt.toString('hex'), 'bootstrap salt == =yencryption salt');
					assert.equal(parseInt(m[2], 16), bootIndex, 'bootstrap index == =yencryption index');
					assert.equal(m[1], cap.salt.toString('hex'));
					assert.equal(m[3], cap.tag.toString('hex'), '=yencryption tag matches the AEAD tag');
					// restored =ybegin keywords before name= (Q-B token boundary)
					var nameAt = lines[0].indexOf(' name=');
					assert.ok(nameAt > 0, 'name= token present on =ybegin');
					var name = lines[0].substring(nameAt + 6);
					assert.equal(name, 'wire.bin');
					var partMatch = lines[0].match(/part=(\d+)/);
					assert.ok(partMatch, 'part= present on =ybegin');
					var partNumber = parseInt(partMatch[1], 10);
					var begin = 1;
					if(ypartLine) {
						var bm = ypartLine.match(/begin=(\d+)/);
						assert.ok(bm, 'begin= present on =ypart');
						begin = parseInt(bm[1], 10);
					}
					// yEnc-decode the data lines between the =yencryption line
					// and the =yend footer, then AEAD-decrypt to the source bytes
					var encIdx = lines.indexOf(yencLine);
					var endIdx = -1;
					lines.forEach(function(l, i) { if(l.indexOf('=yend ') === 0) endIdx = i; });
					assert.ok(endIdx > encIdx, '=yend footer after =yencryption');
					var ciphertext = y.decode(Buffer.from(lines.slice(encIdx + 1, endIdx).join('\r\n'), 'binary'));
					assert.ok(ciphertext.equals(cap.ciphertext), 'wire ciphertext matches the encrypted segment');
					var aad = cryptoUtil.buildBodyAad(partNumber, begin, ciphertext.length, Buffer.from(name, 'utf8'));
					var nonce = cryptoUtil.deriveBodyNonce(key, bootIndex);
					var plain = Buffer.from(xchacha20poly1305(key, nonce, aad).decrypt(Buffer.concat([ciphertext, Buffer.from(m[3], 'hex')])));
					plaintextByIndex[bootIndex] = plain;
				});
				// segments reassemble (in segment-index order) to the source bytes
				var ordered = Object.keys(plaintextByIndex).map(Number).sort(function(a, b) { return a - b; })
					.map(function(k) { return plaintextByIndex[k]; });
				assert.ok(Buffer.concat(ordered).equals(source), 'AEAD-decrypted segments reassemble to the source bytes');
				// NZB <segment bytes> == plaintext (source segment) length
				assert.equal(xmlOutputs.length, 1);
				var xml = Buffer.concat(xmlOutputs[0]).toString('utf8');
				assert.match(xml, /<meta type="yenc_encrypted">true<\/meta>/);
				var segBytes = [];
				var segRe = /<segment bytes="(\d+)" number="(\d+)">/g, sm;
				while((sm = segRe.exec(xml))) segBytes[parseInt(sm[2], 10) - 1] = parseInt(sm[1], 10);
				assert.equal(segBytes.length, captures.length, 'one NZB segment per article');
				// NZB segment order is the posting order; captures are in the
				// same order, so bytes[number-1] is that segment's plaintext length
				captures.forEach(function(cap, i) {
					assert.equal(segBytes[i], cap.ciphertext.length, 'segment bytes == plaintext length for segment ' + (i + 1));
				});
				var total = segBytes.reduce(function(a, b) { return a + b; }, 0);
				assert.equal(total, source.length, 'segment bytes sum to the source length');
			});
		});
	});

	describe('encrypted upload state isolation', function() {
		this.timeout(30000);

		it('reused caller options produce distinct salts and derived nonces, each starting at index 1', function() {
			var captures = [];
			cleanup = installOfflineSink(captures);
			var opts = baseOpts();
			return startUpload(makeStream('same.bin', 'AAAAA'), opts).then(function() {
				return startUpload(makeStream('same.bin', 'BBBBB'), opts);
			}).then(function() {
				assert.equal(captures.length, 2);
				// each invocation starts its own upload session at index 1
				assert.equal(captures[0].index, 1);
				assert.equal(captures[1].index, 1);
				// fresh random per-upload salt for each invocation
				assert.ok(!captures[0].salt.equals(captures[1].salt), 'salts must differ across uploads');
				// keys must differ (derived from distinct salts)
				assert.ok(!captures[0].key.equals(captures[1].key), 'derived keys must differ across uploads');
				// derived body nonces must differ (nonce = HMAC(key, segmentIndex);
				// a fresh salt/key at the same index must yield a different nonce)
				var nonce0 = cryptoUtil.deriveBodyNonce(captures[0].key, captures[0].index);
				var nonce1 = cryptoUtil.deriveBodyNonce(captures[1].key, captures[1].index);
				assert.ok(!nonce0.equals(nonce1), 'derived nonces must differ across uploads');
				// ciphertext XOR does not reveal plaintext XOR
				var xor = Buffer.alloc(5);
				for(var i = 0; i < 5; i++) xor[i] = captures[0].ciphertext[i] ^ captures[1].ciphertext[i];
				var plainXor = Buffer.alloc(5, 'A'.charCodeAt(0) ^ 'B'.charCodeAt(0));
				assert.ok(!xor.equals(plainXor), 'ciphertext XOR must not reveal plaintext XOR');
				// caller's options object must not be mutated with invocation-owned
				// encryption state
				assert.strictEqual(opts.encryption, undefined);
			});
		});

		it('reused caller options with a changed second password authenticate with that password', function() {
			var captures = [];
			cleanup = installOfflineSink(captures);
			var opts = baseOpts();
			var xchacha20poly1305 = require('@noble/ciphers/chacha').xchacha20poly1305;
			return startUpload(makeStream('same.bin', 'AAAAA'), opts).then(function() {
				opts.encryptionPassword = 'conformance-fixture-second-password';
				return startUpload(makeStream('same.bin', 'BBBBB'), opts);
			}).then(function() {
				assert.equal(captures.length, 2);
				assert.ok(!captures[0].key.equals(captures[1].key), 'changed password must derive a new key');
				// the second upload's ciphertext must authenticate and decrypt with
				// the NEW password
				var aad = cryptoUtil.buildBodyAad(1, 1, 5, Buffer.from('same.bin', 'utf8'));
				var sealed = Buffer.concat([captures[1].ciphertext, captures[1].tag]);
				var nonce = cryptoUtil.deriveBodyNonce(captures[1].key, captures[1].index);
				var plain = Buffer.from(xchacha20poly1305(captures[1].key, nonce, aad).decrypt(sealed));
				assert.equal(plain.toString(), 'BBBBB');
				// the OLD password's key must fail authentication on the new upload
				return cryptoUtil.deriveKey('conformance-fixture-password', captures[1].salt).then(function(oldKey) {
					var oldNonce = cryptoUtil.deriveBodyNonce(oldKey, captures[1].index);
					assert.throws(function() {
						xchacha20poly1305(oldKey, oldNonce, aad).decrypt(sealed);
					}, 'old password must not authenticate the second upload');
				});
			});
		});

		it('reused caller options with encryption disabled on second call emits ordinary output with no generated marker', function() {
			var captures = [];
			cleanup = installOfflineSink(captures);
			var xmlOutputs = [];
			var opts = baseOpts({
				nzb: {
					writeTo: function() { return makeXmlCapture(xmlOutputs); },
					metaData: {}
				}
			});
			return startUpload(makeStream('same.bin', 'AAAAA'), opts).then(function() {
				assert.equal(captures.length, 1);
				assert.ok(captures[0].salt, 'first upload must be encrypted');
				opts.encryptionEnabled = false;
				return startUpload(makeStream('same.bin', 'BBBBB'), opts);
			}).then(function() {
				assert.equal(captures.length, 2, 'second upload must complete');
				assert.strictEqual(captures[1].salt, null, 'second upload must not encrypt');
				// ordinary yEnc output, no encryption
				var body2 = captures[1].data.toString('ascii');
				assert.ok(body2.indexOf('=ybegin') >= 0, 'ordinary yEnc header present');
				assert.ok(body2.indexOf('name=same.bin') >= 0, 'ordinary name present in =ybegin');
				assert.ok(body2.indexOf('=yencryption') < 0, 'no generated =yencryption marker');
				// the second upload's NZB XML must not carry generated encryption metadata
				assert.equal(xmlOutputs.length, 2);
				var xml2 = Buffer.concat(xmlOutputs[1]).toString('utf8');
				assert.ok(xml2.indexOf('yenc_encrypted') < 0, 'disabled-encryption reuse must not emit generated marker');
				assert.ok(xml2.indexOf('<meta type="password">') < 0, 'no generated password meta');
				// while the first upload's XML DID carry it
				var xml1 = Buffer.concat(xmlOutputs[0]).toString('utf8');
				assert.match(xml1, /<meta type="yenc_encrypted">true<\/meta>/);
				assert.match(xml1, /<meta type="password">conformance-fixture-password<\/meta>/);
			});
		});

		it('object-form nzb config: caller object and metaData are not mutated; generated XML carries metadata', function() {
			var captures = [];
			cleanup = installOfflineSink(captures);
			var xmlOutputs = [];
			var callerMeta = {custom: 'value'};
			var callerNzb = {
				writeTo: function() { return makeXmlCapture(xmlOutputs); },
				metaData: callerMeta
			};
			var opts = baseOpts({nzb: callerNzb});
			return startUpload(makeStream('same.bin', 'AAAAA'), opts).then(function() {
				assert.equal(captures.length, 1);
				// caller's object identity and contents untouched
				assert.strictEqual(opts.nzb, callerNzb);
				assert.strictEqual(opts.nzb.metaData, callerMeta);
				assert.equal(callerMeta.yenc_encrypted, undefined);
				assert.equal(callerMeta.password, undefined);
				// generated XML carries the metadata
				var xml = Buffer.concat(xmlOutputs[0]).toString('utf8');
				assert.match(xml, /<meta type="custom">value<\/meta>/);
				assert.match(xml, /<meta type="yenc_encrypted">true<\/meta>/);
				assert.match(xml, /<meta type="password">conformance-fixture-password<\/meta>/);
			});
		});

		it('factory-form nzb: caller factory and its returned identity/metadata are unchanged; generated XML carries metadata', function() {
			var captures = [];
			cleanup = installOfflineSink(captures);
			var xmlOutputs = [];
			var factoryCalls = 0;
			var factoryReturned = null;
			var factoryNzb = function() {
				factoryCalls++;
				factoryReturned = ['nzb-id-' + factoryCalls, {
					writeTo: function() { return makeXmlCapture(xmlOutputs); },
					metaData: {custom: 'value'}
				}];
				return factoryReturned;
			};
			var opts = baseOpts({nzb: factoryNzb});
			return startUpload(makeStream('same.bin', 'AAAAA'), opts).then(function() {
				assert.equal(captures.length, 1);
				// caller's factory function identity unchanged
				assert.strictEqual(opts.nzb, factoryNzb);
				assert.equal(factoryCalls, 1);
				// caller's returned object must not be mutated: re-invoke the
				// factory and verify the fresh metaData has no generated fields
				var fresh = factoryNzb();
				assert.strictEqual(fresh, factoryReturned);
				assert.equal(fresh[1].metaData.yenc_encrypted, undefined);
				assert.equal(fresh[1].metaData.password, undefined);
				// generated XML carries the metadata
				var xml = Buffer.concat(xmlOutputs[0]).toString('utf8');
				assert.match(xml, /<meta type="custom">value<\/meta>/);
				assert.match(xml, /<meta type="yenc_encrypted">true<\/meta>/);
				assert.match(xml, /<meta type="password">conformance-fixture-password<\/meta>/);
			});
		});

		it('preserves caller-supplied low-level encryption context unchanged', function() {
			var captures = [];
			cleanup = installOfflineSink(captures);
			var suppliedKey = Buffer.alloc(32, 9);
			var suppliedSalt = cryptoUtil.generateEncryptionSalt();
			var suppliedContext = {
				key: suppliedKey,
				salt: suppliedSalt
			};
			var opts = baseOpts({
				encryption: suppliedContext
			});
			return startUpload(makeStream('same.bin', 'AAAAA'), opts).then(function() {
				assert.equal(captures.length, 1);
				// the supplied key and salt were used directly
				assert.ok(captures[0].key.equals(suppliedKey));
				assert.ok(captures[0].salt.equals(suppliedSalt));
				// caller's supplied object reference is preserved
				assert.strictEqual(opts.encryption, suppliedContext);
			});
		});

		it('caller-supplied encryption context still gets NZB encryption meta without re-deriving the key (NY12-02)', function() {
			var captures = [];
			cleanup = installOfflineSink(captures);
			var xmlOutputs = [];
			var suppliedKey = Buffer.alloc(32, 9);
			var suppliedSalt = cryptoUtil.generateEncryptionSalt();
			var suppliedContext = {key: suppliedKey, salt: suppliedSalt};
			var callerMeta = {custom: 'value'};
			var callerNzb = {
				writeTo: function() { return makeXmlCapture(xmlOutputs); },
				metaData: callerMeta
			};
			var opts = baseOpts({
				encryption: suppliedContext,
				encryptionPassword: 'fixture-supplied-value',
				nzb: callerNzb
			});
			return startUpload(makeStream('same.bin', 'AAAAA'), opts).then(function() {
				assert.equal(captures.length, 1);
				// the supplied key/salt were used directly (no re-derivation)
				assert.ok(captures[0].key.equals(suppliedKey));
				assert.ok(captures[0].salt.equals(suppliedSalt));
				assert.strictEqual(opts.encryption, suppliedContext);
				// caller's nzb/metaData objects are not mutated
				assert.strictEqual(opts.nzb, callerNzb);
				assert.equal(callerMeta.yenc_encrypted, undefined);
				assert.equal(callerMeta.password, undefined);
				// emitted NZB XML carries the encryption meta
				assert.equal(xmlOutputs.length, 1);
				var xml = Buffer.concat(xmlOutputs[0]).toString('utf8');
				assert.match(xml, /<meta type="custom">value<\/meta>/);
				assert.match(xml, /<meta type="yenc_encrypted">true<\/meta>/);
				assert.match(xml, /<meta type="password">fixture-supplied-value<\/meta>/);
			});
		});

		it('caller-supplied encryption context with factory-form nzb still gets NZB encryption meta (NY12-02)', function() {
			var captures = [];
			cleanup = installOfflineSink(captures);
			var xmlOutputs = [];
			var suppliedKey = Buffer.alloc(32, 9);
			var suppliedSalt = cryptoUtil.generateEncryptionSalt();
			var callerMeta;
			var nzbFactory = function() {
				callerMeta = {custom: 'value'};
				return ['custom_nzb', {
					writeTo: function() { return makeXmlCapture(xmlOutputs); },
					metaData: callerMeta
				}];
			};
			var opts = baseOpts({
				encryption: {key: suppliedKey, salt: suppliedSalt},
				encryptionPassword: 'fixture-supplied-value',
				nzb: nzbFactory
			});
			return startUpload(makeStream('same.bin', 'AAAAA'), opts).then(function() {
				assert.equal(captures.length, 1);
				assert.ok(captures[0].key.equals(suppliedKey));
				assert.ok(captures[0].salt.equals(suppliedSalt));
				assert.strictEqual(opts.nzb, nzbFactory);
				assert.equal(callerMeta.yenc_encrypted, undefined);
				assert.equal(callerMeta.password, undefined);
				assert.equal(xmlOutputs.length, 1);
				var xml = Buffer.concat(xmlOutputs[0]).toString('utf8');
				assert.match(xml, /<meta type="yenc_encrypted">true<\/meta>/);
				assert.match(xml, /<meta type="password">fixture-supplied-value<\/meta>/);
			});
		});

		it('caller-supplied encryption context without a known password emits no encryption meta (NY12-02)', function() {
			var captures = [];
			cleanup = installOfflineSink(captures);
			var xmlOutputs = [];
			var suppliedKey = Buffer.alloc(32, 9);
			var suppliedSalt = cryptoUtil.generateEncryptionSalt();
			var opts = baseOpts({
				encryption: {key: suppliedKey, salt: suppliedSalt},
				encryptionPassword: undefined,
				nzb: {
					writeTo: function() { return makeXmlCapture(xmlOutputs); },
					metaData: {}
				}
			});
			return startUpload(makeStream('same.bin', 'AAAAA'), opts).then(function() {
				assert.equal(captures.length, 1);
				assert.ok(captures[0].key.equals(suppliedKey));
				assert.equal(xmlOutputs.length, 1);
				var xml = Buffer.concat(xmlOutputs[0]).toString('utf8');
				assert.ok(xml.indexOf('yenc_encrypted') < 0, 'no marker without a known password');
				assert.ok(xml.indexOf('<meta type="password">') < 0, 'no password meta without a known password');
			});
		});

		it('emitted encryption password is authoritative over an emitted archive password', function() {
			var captures = [];
			cleanup = installOfflineSink(captures);
			var xmlOutputs = [];
			var opts = baseOpts({
				encryptionPassword: 'fixture-transport-value',
				nzb: {
					writeTo: function() { return makeXmlCapture(xmlOutputs); },
					metaData: {password: 'fixture-archive-value'}
				}
			});
			return startUpload(makeStream('same.bin', 'AAAAA'), opts).then(function() {
				assert.equal(captures.length, 1);
				// caller's metaData untouched
				assert.equal(opts.nzb.metaData.password, 'fixture-archive-value');
				// generated XML: the transport password wins
				var xml = Buffer.concat(xmlOutputs[0]).toString('utf8');
				assert.match(xml, /<meta type="password">fixture-transport-value<\/meta>/);
				assert.ok(xml.indexOf('fixture-archive-value') < 0, 'archive password must not appear in emitted XML');
				assert.equal(xml.match(/<meta type="password">/g).length, 1);
			});
		});
	});

	// UP-NY-2: a yencName override (literal or dynamic) is resolved and
	// CR/LF/NUL-stripped inside MultiEncoder (lib/article.js), after the
	// fileuploader preflight that only checks the original file name. For an
	// encrypted upload the resolved name becomes the AEAD AAD subject, which
	// Body Std §2.1 (v1.2) requires to be non-empty. The resulting RangeError
	// must surface through the normal upload error callback exactly once -
	// not escape as an uncaught exception from the read loop, which would
	// hang the upload without ever delivering cb(err).
	describe('effective empty yEnc name with encryption (UP-NY-2)', function() {
		this.timeout(30000);

		it('errors exactly once via the upload callback for an empty literal yencName override', function() {
			var captures = [];
			cleanup = installOfflineSink(captures);
			var opts = baseOpts({yencName: ''});
			return startUpload(makeStream('file.bin', 'hello'), opts).then(function() {
				throw new Error('upload should have failed with an empty AAD name error');
			}, function(err) {
				assert.ok(err instanceof RangeError, 'expected RangeError, got: ' + err);
				assert.match(err.message, /AAD name must not be empty/);
				assert.equal(captures.length, 0, 'no articles may be posted for the failed file');
			});
		});

		it('errors exactly once via the upload callback for a sanitized-to-empty literal yencName override', function() {
			var captures = [];
			cleanup = installOfflineSink(captures);
			var opts = baseOpts({yencName: '\r\n\0'});
			return startUpload(makeStream('file.bin', 'hello'), opts).then(function() {
				throw new Error('upload should have failed with an empty AAD name error');
			}, function(err) {
				assert.ok(err instanceof RangeError, 'expected RangeError, got: ' + err);
				assert.match(err.message, /AAD name must not be empty/);
				assert.equal(captures.length, 0, 'no articles may be posted for the failed file');
			});
		});

		it('errors exactly once via the upload callback for a dynamic yencName that sanitizes to empty, without re-evaluating the function', function() {
			var captures = [];
			cleanup = installOfflineSink(captures);
			var calls = 0;
			var opts = baseOpts({yencName: function(fileNum, fileNumTotal, filename, size, part, parts) {
				calls++;
				return '\r\n\0';
			}});
			return startUpload(makeStream('file.bin', 'hello'), opts).then(function() {
				throw new Error('upload should have failed with an empty AAD name error');
			}, function(err) {
				assert.ok(err instanceof RangeError, 'expected RangeError, got: ' + err);
				assert.match(err.message, /AAD name must not be empty/);
				assert.equal(captures.length, 0, 'no articles may be posted for the failed file');
				// established semantics: the name function is evaluated once
				// per file (in the MultiEncoder constructor); the failure path
				// must not add a second evaluation
				assert.equal(calls, 1, 'dynamic name function must not be evaluated an extra time');
			});
		});

		it('valid literal yencName override uploads encrypted with that name as the AAD subject', function() {
			var captures = [];
			cleanup = installOfflineSink(captures);
			var opts = baseOpts({yencName: 'renamed.bin'});
			return startUpload(makeStream('file.bin', 'hello'), opts).then(function() {
				assert.equal(captures.length, 1);
				var xchacha20poly1305 = require('@noble/ciphers/chacha').xchacha20poly1305;
				var aad = cryptoUtil.buildBodyAad(1, 1, 5, Buffer.from('renamed.bin', 'utf8'));
				var sealed = Buffer.concat([captures[0].ciphertext, captures[0].tag]);
				var nonce = cryptoUtil.deriveBodyNonce(captures[0].key, captures[0].index);
				var plain = Buffer.from(xchacha20poly1305(captures[0].key, nonce, aad).decrypt(sealed));
				assert.equal(plain.toString(), 'hello');
			});
		});

		it('valid dynamic yencName function is evaluated exactly once per file and its name is used as the AAD subject', function() {
			var captures = [];
			cleanup = installOfflineSink(captures);
			var calls = 0;
			var args = null;
			var opts = baseOpts({yencName: function(fileNum, fileNumTotal, filename, size, part, parts) {
				calls++;
				args = [fileNum, fileNumTotal, filename, size, part, parts];
				return 'dyn-' + fileNum + '-' + filename;
			}});
			return startUpload(makeStream('file.bin', 'hello'), opts).then(function() {
				assert.equal(captures.length, 1);
				assert.equal(calls, 1, 'dynamic name function must be evaluated exactly once per file');
				assert.deepStrictEqual(args, [1, 1, 'file.bin', 5, 1, 1]);
				var xchacha20poly1305 = require('@noble/ciphers/chacha').xchacha20poly1305;
				var aad = cryptoUtil.buildBodyAad(1, 1, 5, Buffer.from('dyn-1-file.bin', 'utf8'));
				var sealed = Buffer.concat([captures[0].ciphertext, captures[0].tag]);
				var nonce = cryptoUtil.deriveBodyNonce(captures[0].key, captures[0].index);
				var plain = Buffer.from(xchacha20poly1305(captures[0].key, nonce, aad).decrypt(sealed));
				assert.equal(plain.toString(), 'hello');
			});
		});

		// Ordinary (non-encrypted) uploads keep upstream behavior: the empty
		// override is written verbatim into the =ybegin header and the upload
		// succeeds - no AAD exists to validate, so nothing fails.
		it('ordinary unencrypted upload keeps upstream behavior for an empty yencName override', function() {
			var captures = [];
			cleanup = installOfflineSink(captures);
			var opts = baseOpts({encryptionEnabled: false, yencName: ''});
			return startUpload(makeStream('file.bin', 'hello'), opts).then(function() {
				assert.equal(captures.length, 1);
				assert.strictEqual(captures[0].salt, null, 'upload must not be encrypted');
				var body = captures[0].data.toString('ascii');
				assert.ok(body.indexOf('=ybegin') >= 0, 'ordinary yEnc header present');
				assert.ok(body.indexOf(' name=\r\n') >= 0, 'empty override written verbatim into =ybegin');
			});
		});
	});

	// NY12-03: encrypted-path throws from submitPost (index exhaustion and
	// non-AAD crypto failures inside enc.generate) must reach the upload
	// callback exactly once via fileDone, not escape the read loop.
	// Ordinary-post throws keep the upstream throw-out behavior.
	describe('encrypted submitPost error routing (NY12-03)', function() {
		this.timeout(30000);
		var UploadManager = require('../lib/uploadmgr');
		// UploadManager captures `lib/uploader` at load time; stub the
		// instance's uploader so addFile can run without any network.
		function makeManager(opts, cb) {
			var mgr;
			try {
				mgr = new UploadManager(opts, cb || function() {});
			} catch(e) {
				// uploader construction may need servers; fall back to a
				// bare instance carrying only what addFile touches
				mgr = Object.create(UploadManager.prototype);
				mgr.opts = opts;
				mgr.articleSize = opts.articleSize || 768000;
				mgr.segmentIndex = 0;
				mgr.nzbs = {};
				mgr.bufferPool = null;
				mgr.dateOverride = null;
			}
			mgr.uploader = {
				addPost: function(post, readCb, postedCb) { postedCb(null); readCb(null); },
				finished: function() {},
				cancel: function() {}
			};
			return mgr;
		}
		function fakeStream(chunks) {
			var i = 0;
			return {
				read: function(size, cb) {
					if(i < chunks.length) cb(null, chunks[i++]);
					else cb(null, Buffer.alloc(0));
				}
			};
		}

		it('routes segmentIndex exhaustion through fileDone exactly once', function(done) {
			// a valid supplied context so enc.encryption is set
			var mgr = makeManager(baseOpts({useBufferPool: false, encryption: {key: Buffer.alloc(32, 1), salt: cryptoUtil.generateEncryptionSalt()}}));
			// pre-exhaust the allocator: the next index allocation throws
			mgr.segmentIndex = 0xFFFFFFFF;
			var calls = 0, seenErr = null;
			mgr.addFile({name: 'file.bin', size: 5, num: 1}, 1, {}, fakeStream([Buffer.from('hello')]), function(err) {
				calls++;
				seenErr = err;
				setImmediate(function() {
					try {
						assert.equal(calls, 1, 'fileDone must be called exactly once');
						assert.ok(seenErr, 'exhaustion error expected');
						assert.match(seenErr.message, /segmentIndex space exhausted/);
						done();
					} catch(e) { done(e); }
				});
			});
		});

		it('routes a non-AAD crypto throw from enc.generate through fileDone exactly once', function(done) {
			var mgr = makeManager(baseOpts({useBufferPool: false}));
			// a 31-byte key makes encryptBody throw a RangeError that is not
			// the AAD-name error
			mgr.opts.encryption = {key: Buffer.alloc(31), salt: cryptoUtil.generateEncryptionSalt()};
			var calls = 0, seenErr = null;
			mgr.addFile({name: 'file.bin', size: 5, num: 1}, 1, {}, fakeStream([Buffer.from('hello')]), function(err) {
				calls++;
				seenErr = err;
				setImmediate(function() {
					try {
						assert.equal(calls, 1, 'fileDone must be called exactly once');
						assert.ok(seenErr, 'crypto error expected');
						assert.match(seenErr.message, /must be exactly 32 bytes/);
						done();
					} catch(e) { done(e); }
				});
			});
		});

		it('ordinary-post throws still escape submitPost (upstream behavior untouched)', function() {
			var mgr = makeManager(baseOpts({encryptionEnabled: false, encryptionPassword: undefined, useBufferPool: false}));
			delete mgr.opts.encryption;
			// an ordinary generate() throw (here: invalid article state from
			// a stream that yields a chunk after EOF signalling) must keep
			// escaping instead of being routed to fileDone
			var ArticleEncoder2 = require('../lib/article');
			var origGenerate = ArticleEncoder2.prototype.generate;
			ArticleEncoder2.prototype.generate = function() { throw new Error('ordinary boom'); };
			try {
				assert.throws(function() {
					mgr.addFile({name: 'file.bin', size: 5, num: 1}, 1, {}, fakeStream([Buffer.from('hello')]), function() {
						throw new Error('fileDone must not be called for an ordinary throw');
					});
				}, /ordinary boom/);
			} finally {
				ArticleEncoder2.prototype.generate = origGenerate;
			}
		});
	});

	describe('CLI encryption flag and option precedence', function() {
		var child_process = require('child_process');
		var path = require('path');
		var binNyuu = path.resolve(__dirname, '../bin/nyuu.js');
		var os = require('os');
		var fs = require('fs');
		var tmpDir, notty;

		var NNTPServer = require('./_nntpsrv');
		var rawPostPath;

		before(function() {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyuu-test-'));
			notty = path.join(tmpDir, 'notty.json');
			fs.writeFileSync(notty, JSON.stringify({colorize: false}));
			rawPostPath = path.join(tmpDir, 'rawpost.bin');
			fs.writeFileSync(rawPostPath, 'Message-ID: <test@msg.id>\r\nSubject: test\r\nFrom: test\r\nNewsgroups: rifles\r\n\r\n=ybegin line=128 size=4 name=test\r\ntest\r\n=yend size=4\r\n.\r\n');
		});
		after(function() {
			fs.rmSync(tmpDir, {recursive: true, force: true});
		});

		it('fails when --encrypt is given without a password', function(done) {
			child_process.execFile(process.execPath, [binNyuu, '-C', notty, '--encrypt'], function(err, stdout, stderr) {
				assert.ok(err, 'should fail with non-zero exit code');
				assert.match(stderr, /--encrypt-password.*required/);
				done();
			});
		});

		it('implicitly enables encryption when only --encrypt-password is provided', function(done) {
			child_process.execFile(process.execPath, [binNyuu, '-C', notty, '--encrypt-password', 'conformance-fixture-cli-password'], function(err, stdout, stderr) {
				assert.doesNotMatch(stderr, /--encrypt-password.*required/);
				assert.match(stderr, /Must supply at least one input file/);
				done();
			});
		});

		// helper: spins up a local NNTP listener and returns {server, port}
		// tracking inbound connections; used to prove raw+encryption rejections
		// happen before any network activity.
		var makeListeningServer = function(cb) {
			var connections = 0;
			var server = new NNTPServer();
			server.onConnect(function() {
				connections++;
			});
			server.listen(0, function() {
				cb(null, server, server.address().port, function() { return connections; });
			});
		};

		it('rejects --input-raw-posts with --encrypt-password before any connection (NY-NEXT-2)', function(done) {
			makeListeningServer(function(err, server, port, getConnections) {
				if(err) return done(err);
				child_process.execFile(process.execPath, [binNyuu, '-C', notty, '-h', '127.0.0.1', '-P', port, '--input-raw-posts', '--encrypt-password', 'conformance-fixture-cli-password', rawPostPath], function(err2, stdout, stderr) {
					server.close(function() {
						assert.ok(err2, 'should fail with non-zero exit code');
						assert.match(stderr, /Encryption is not supported with `--input-raw-posts`/i, 'early diagnostic expected, got: ' + stderr);
						assert.strictEqual(getConnections(), 0, 'zero connection attempts expected');
						done();
					});
				});
			});
		});

		it('rejects --input-raw-posts with --encrypt before any connection (NY-NEXT-2)', function(done) {
			makeListeningServer(function(err, server, port, getConnections) {
				if(err) return done(err);
				child_process.execFile(process.execPath, [binNyuu, '-C', notty, '-h', '127.0.0.1', '-P', port, '--input-raw-posts', '--encrypt', '--encrypt-password', 'conformance-fixture-cli-password', rawPostPath], function(err2, stdout, stderr) {
					server.close(function() {
						assert.ok(err2, 'should fail with non-zero exit code');
						assert.match(stderr, /Encryption is not supported with `--input-raw-posts`/i, 'early diagnostic expected, got: ' + stderr);
						assert.strictEqual(getConnections(), 0, 'zero connection attempts expected');
						done();
					});
				});
			});
		});

		it('rejects config-enabled encryption with --input-raw-posts before any connection (NY-NEXT-2)', function(done) {
			makeListeningServer(function(err, server, port, getConnections) {
				if(err) return done(err);
				var cfgPath = path.join(tmpDir, 'raw-enc-config.json');
				fs.writeFileSync(cfgPath, JSON.stringify({
					colorize: false,
					'encrypt-password': 'conformance-fixture-cli-password'
				}));
				child_process.execFile(process.execPath, [binNyuu, '-C', cfgPath, '-h', '127.0.0.1', '-P', port, '--input-raw-posts', rawPostPath], function(err2, stdout, stderr) {
					server.close(function() {
						fs.unlinkSync(cfgPath);
						assert.ok(err2, 'should fail with non-zero exit code');
						assert.match(stderr, /Encryption is not supported with `--input-raw-posts`/i, 'early diagnostic expected, got: ' + stderr);
						assert.strictEqual(getConnections(), 0, 'zero connection attempts expected');
						done();
					});
				});
			});
		});

		it('explicit --no-encrypt overrides config-enabled encryption for --input-raw-posts', function(done) {
			makeListeningServer(function(err, server, port, getConnections) {
				if(err) return done(err);
				var cfgPath = path.join(tmpDir, 'raw-enc-config.json');
				fs.writeFileSync(cfgPath, JSON.stringify({
					colorize: false,
					'encrypt-password': 'conformance-fixture-cli-password'
				}));
				child_process.execFile(process.execPath, [binNyuu, '-C', cfgPath, '-h', '127.0.0.1', '-P', port, '--input-raw-posts', '--no-encrypt', rawPostPath], function(err2, stdout, stderr) {
					server.close(function() {
						fs.unlinkSync(cfgPath);
						assert.ifError(err2);
						assert.doesNotMatch(stderr, /Encryption is not supported with `--input-raw-posts`/i);
						assert.ok(getConnections() > 0, 'expected actual connection attempts in pass-through raw mode');
						done();
					});
				});
			});
		});

		// DEC-3 / NY-R10-02: full JS configs merge `encryptionPassword` and
		// `encryptionEnabled` directly onto ulOpts (isFullConfig && confType == 'js'),
		// bypassing the CLI opt mapping. The three neighboring semantics are pinned
		// here via the same --input-raw-posts probe used above: encryption enabled
		// rejects raw posts before any connection, disabled passes through.
		// Full JS configs assign `module.exports = {...}` (as config.js does);
		// the `exports` token is how bin/nyuu.js detects a JS config, and
		// `isFullConfig: true` selects the direct ulOpts merge path.

		it('full JS config with encryptionEnabled:false and a password does not enable encryption (NY-R10-02 case 3)', function(done) {
			makeListeningServer(function(err, server, port, getConnections) {
				if(err) return done(err);
				var cfgPath = path.join(tmpDir, 'full-disabled.js');
				fs.writeFileSync(cfgPath, 'module.exports = {isFullConfig: true, encryptionPassword: "conformance-fixture-cli-password", encryptionEnabled: false, cli: {colorize: false}};\n');
				child_process.execFile(process.execPath, [binNyuu, '-C', cfgPath, '-h', '127.0.0.1', '-P', port, '--input-raw-posts', rawPostPath], function(err2, stdout, stderr) {
					server.close(function() {
						fs.unlinkSync(cfgPath);
						try {
							assert.ifError(err2);
							assert.doesNotMatch(stderr, /Encryption is not supported with `--input-raw-posts`/i);
							assert.ok(getConnections() > 0, 'expected actual connection attempts in pass-through raw mode');
							done();
						} catch(e) { done(e); }
					});
				});
			});
		});

		it('explicit --encrypt overrides a full JS config that disables encryption (NY-R10-02 case 1)', function(done) {
			makeListeningServer(function(err, server, port, getConnections) {
				if(err) return done(err);
				var cfgPath = path.join(tmpDir, 'full-disabled-cli-encrypt.js');
				fs.writeFileSync(cfgPath, 'module.exports = {isFullConfig: true, encryptionPassword: "conformance-fixture-cli-password", encryptionEnabled: false, cli: {colorize: false}};\n');
				child_process.execFile(process.execPath, [binNyuu, '-C', cfgPath, '-h', '127.0.0.1', '-P', port, '--input-raw-posts', '--encrypt', rawPostPath], function(err2, stdout, stderr) {
					server.close(function() {
						fs.unlinkSync(cfgPath);
						try {
							assert.ok(err2, 'should fail with non-zero exit code');
							assert.match(stderr, /Encryption is not supported with `--input-raw-posts`/i, 'early diagnostic expected, got: ' + stderr);
							assert.strictEqual(getConnections(), 0, 'zero connection attempts expected');
							done();
						} catch(e) { done(e); }
					});
				});
			});
		});

		it('fails when explicit --encrypt-password is empty (NY12-01)', function(done) {
			// `--encrypt-password=` is the explicit-empty form (a bare
			// trailing '' is rejected earlier by the arg parser itself)
			child_process.execFile(process.execPath, [binNyuu, '-C', notty, '--encrypt-password='], function(err, stdout, stderr) {
				try {
					assert.ok(err, 'should fail with non-zero exit code');
					assert.match(stderr, /--encrypt-password.*must not be empty/);
					assert.doesNotMatch(stderr, /Must supply at least one input file/);
					done();
				} catch(e) { done(e); }
			});
		});

		it('fails when explicit --encrypt-password is empty even with --encrypt (NY12-01)', function(done) {
			child_process.execFile(process.execPath, [binNyuu, '-C', notty, '--encrypt', '--encrypt-password='], function(err, stdout, stderr) {
				try {
					assert.ok(err, 'should fail with non-zero exit code');
					assert.match(stderr, /--encrypt-password.*must not be empty/);
					done();
				} catch(e) { done(e); }
			});
		});

		it('explicit CLI --encrypt-password overrides a full JS config that disables encryption (R11-NY-01)', function(done) {
			makeListeningServer(function(err, server, port, getConnections) {
				if(err) return done(err);
				var cfgPath = path.join(tmpDir, 'full-disabled-cli-password.js');
				fs.writeFileSync(cfgPath, 'module.exports = {isFullConfig: true, encryptionPassword: "conformance-fixture-cli-password", encryptionEnabled: false, cli: {colorize: false}};\n');
				child_process.execFile(process.execPath, [binNyuu, '-C', cfgPath, '-h', '127.0.0.1', '-P', port, '--input-raw-posts', '--encrypt-password', 'conformance-fixture-cli-password', rawPostPath], function(err2, stdout, stderr) {
					server.close(function() {
						fs.unlinkSync(cfgPath);
						try {
							assert.ok(err2, 'should fail with non-zero exit code');
							assert.match(stderr, /Encryption is not supported with `--input-raw-posts`/i, 'early diagnostic expected, got: ' + stderr);
							assert.strictEqual(getConnections(), 0, 'zero connection attempts expected');
							done();
						} catch(e) { done(e); }
					});
				});
			});
		});

		it('full JS config with a password and no encryptionEnabled still enables encryption (NY-R10-02 case 2)', function(done) {
			makeListeningServer(function(err, server, port, getConnections) {
				if(err) return done(err);
				var cfgPath = path.join(tmpDir, 'full-password-only.js');
				fs.writeFileSync(cfgPath, 'module.exports = {isFullConfig: true, encryptionPassword: "conformance-fixture-cli-password", cli: {colorize: false}};\n');
				child_process.execFile(process.execPath, [binNyuu, '-C', cfgPath, '-h', '127.0.0.1', '-P', port, '--input-raw-posts', rawPostPath], function(err2, stdout, stderr) {
					server.close(function() {
						fs.unlinkSync(cfgPath);
						try {
							assert.ok(err2, 'should fail with non-zero exit code');
							assert.match(stderr, /Encryption is not supported with `--input-raw-posts`/i, 'early diagnostic expected, got: ' + stderr);
							assert.strictEqual(getConnections(), 0, 'zero connection attempts expected');
							done();
						} catch(e) { done(e); }
					});
				});
			});
		});

		it('already-encrypted raw input repost without encryption flags remains pass-through', function(done) {
			makeListeningServer(function(err, server, port, getConnections) {
				if(err) return done(err);
				child_process.execFile(process.execPath, [binNyuu, '-C', notty, '-h', '127.0.0.1', '-P', port, '--input-raw-posts', rawPostPath], function(err2, stdout, stderr) {
					server.close(function() {
						assert.ifError(err2);
						assert.doesNotMatch(stderr, /Encryption is not supported with `--input-raw-posts`/i);
						assert.ok(getConnections() > 0, 'expected actual connection attempts in pass-through raw mode');
						done();
					});
				});
			});
		});
	});
});
