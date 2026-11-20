"use strict";

var assert = require('assert');
var path = require('path');

var cryptoCore = require('../lib/crypto');
var ff1 = require('../lib/ff1');
var ff1Decrypt = require('./_ff1decrypt');
// Exercise individual lines through the production block API.
function encryptControlLine(line, key, segmentIndex, lineIndex, salt) {
	var prefix = Buffer.from('=ybegin name=test\r\n' + '\r\n'.repeat(Math.max(0, lineIndex - 2)));
	if(lineIndex === 1) prefix = Buffer.alloc(0);
	var block = Buffer.concat([prefix, line, Buffer.from('\r\n')]);
	var wire = ff1.encryptControlLines(block, key, segmentIndex, salt);
	return wire.subarray(wire.length - line.length - (lineIndex === 1 ? 20 : 0) - 2, wire.length - 2);
}

// Test-only decryption helper (Body Std §4): decryptBody was removed from
// lib/crypto.js because only the tests need it; nyuu only ever encrypts.
function decryptBody(ciphertext, tag, key, segmentIndex, aad) {
	var nonce = cryptoCore.deriveBodyNonce(key, segmentIndex);
	var cipher = require('@noble/ciphers/chacha').xchacha20poly1305(key, nonce, aad);
	return Buffer.from(cipher.decrypt(Buffer.concat([ciphertext, tag])));
}


var vectorsDir = path.resolve(__dirname, 'test-vectors');
var fs = require('fs');
var argonVectors = require(path.join(vectorsDir, 'argon2id.json'));
var nonceVectors = require(path.join(vectorsDir, 'nonce_tweak.json'));
var bodyVectors = require(path.join(vectorsDir, 'body_encryption.json'));
var controlVectors = require(path.join(vectorsDir, 'control_line_encryption.json'));

// the canonical fixture set (byte-identical copies of
// the reference standards repository's vectors)
// Vendored fixtures: argon2id.json, body_encryption.json,
// control_line_encryption.json, index_allocation.json, nonce_tweak.json
// (nzb_segment_identity.json and malformed_inputs.json are
// downloader-side fixtures and are not exercised by Nyuu's uploader tests)
// Standards baseline commit: 4dfc1cd5820af6eade7f4f76f836c3704ac77989,
// with the unpublished v1.2 cleanup applied. Vectors are helper artifacts
// (no hash-enforced manifest); refreshed by hand from the standards repo
// when the canonical fixtures change.

function hex(value) {
	return Buffer.from(value).toString('hex');
}

function fb(vector, name) {
	return Buffer.from(vector[name + '_bytes']);
}
function fbList(vector, name) {
	return vector[name + '_bytes'].map(function(item) { return Buffer.from(item); });
}

describe('yEnc encryption crypto', function() {
	this.timeout(30000);

	it('matches every canonical Argon2id vector', async function() {
		for(var i = 0; i < argonVectors.vectors.length; i++) {
			var vector = argonVectors.vectors[i];
			var key = await cryptoCore.deriveKey(vector.password, fb(vector, 'salt'));
			assert.deepEqual(key, fb(vector, 'expected_key'), vector.id);
		}
	});

	it('matches canonical body nonce and control key/tweak vectors', function() {
		nonceVectors.body_nonce_vectors.forEach(function(vector) {
			var nonce = cryptoCore.deriveBodyNonce(fb(vector, 'key'), vector.segment_index);
			assert.deepEqual(nonce, fb(vector, 'expected_nonce'), vector.id);
		});
		nonceVectors.control_tweak_vectors.forEach(function(vector) {
			var masterKey = fb(vector, 'master_key');
			assert.deepEqual(cryptoCore.deriveControlKey(masterKey), fb(vector, 'enc_key'), vector.id + ' key');
			assert.deepEqual(
				cryptoCore.deriveControlTweak(masterKey, vector.segment_index, vector.line_index),
				fb(vector, 'expected_tweak'),
				vector.id + ' tweak'
			);
		});
	});

	it('matches canonical XChaCha20-Poly1305 vectors with AAD', function() {
		bodyVectors.vectors.forEach(function(vector) {
			var nonce = cryptoCore.deriveBodyNonce(fb(vector, 'derived_key'), vector.segment_index);
			assert.deepEqual(nonce, fb(vector, 'derived_nonce'), vector.id + ' nonce');
			var nameBytes = fb(vector.aad, 'name_bytes');
			var aad = cryptoCore.buildBodyAad(vector.aad.part_number, vector.aad.part_begin, vector.aad.segment_bytes, nameBytes);
			assert.deepEqual(aad, fb(vector.aad, 'expected_aad'), vector.id + ' aad');
			var key = fb(vector, 'derived_key');
			var plaintext = fb(vector, 'plaintext');
			var result = cryptoCore.encryptBody(
				plaintext,
				key,
				vector.segment_index,
				aad
			);
			assert.deepEqual(result.ciphertext, fb(vector, 'expected_ciphertext'), vector.id + ' ciphertext');
			assert.deepEqual(result.tag, fb(vector, 'expected_tag'), vector.id + ' tag');
			var formattedIndex = vector.segment_index.toString(16).padStart(8, '0');
			var indexBuffer = Buffer.alloc(4); indexBuffer.writeUInt32BE(vector.segment_index, 0);
			assert.deepEqual(indexBuffer, fb(vector, 'expected_index'), vector.id + ' index_bytes');
			var expectedLine = '=yencryption cipher=XChaCha20-Poly1305 salt=' + fb(vector, 'salt').toString('hex') +
				' index=' + formattedIndex +
				' tag=' + hex(result.tag);
			assert.equal(expectedLine, vector.expected_yencryption_line, vector.id + ' yencryption_line');

			// verify decryption with correct AAD succeeds
			var decrypted = decryptBody(result.ciphertext, result.tag, key, vector.segment_index, aad);
			assert.deepEqual(decrypted, fb(vector, 'plaintext'), vector.id + ' decrypt');

			// verify tampering with AAD fails authentication
			var badAad = Buffer.from(aad);
			badAad[badAad.length - 1] ^= 1;
			assert.throws(function() {
				decryptBody(result.ciphertext, result.tag, key, vector.segment_index, badAad);
			}, /invalid tag/, vector.id + ' tampered aad');
		});
	});

	it('matches canonical Radix 253 FF1 vectors and validates 20-byte Line 1 expansion', function() {
		controlVectors.vectors.forEach(function(vector) {
			if(!vector.plaintext_line) return;
			var masterKey = fb(nonceVectors.control_tweak_vectors[0], 'master_key');
			var plaintext = Buffer.from(vector.plaintext_line, 'ascii');
			var salt = fb(vector, 'salt');
			var wire = encryptControlLine(
				plaintext,
				masterKey,
				vector.segment_index,
				vector.line_index,
				salt
			);
			assert.deepEqual(wire, fb(vector, 'expected_wire'), vector.id);
			if(vector.line_index === 1) {
				assert.equal(wire.length, plaintext.length + 20, vector.id + ' length');
				assert.deepEqual(wire.subarray(0, 16), fb(vector, 'salt'), vector.id + ' salt');
				assert.equal(wire.subarray(16, 20).readUInt32BE(0), vector.segment_index, vector.id + ' segmentIndex');
			} else {
				assert.equal(wire.length, plaintext.length, vector.id + ' length');
			}
		});
	});

	it('encrypts only control lines while preserving line endings and data', function() {
		['control-vec-07-full-article-5-lines', 'control-vec-08-full-article-54-lines',
			'control-vec-09-one-byte-data', 'control-vec-10-exact-wrap-article-6-lines',
			'control-vec-11-combined-one-byte-data', 'control-vec-12-single-part-name-contains-part'
		].forEach(function(vecId) {
			var vector = controlVectors.vectors.filter(function(item) {
				return item.id === vecId;
			})[0];
			assert(vector, 'missing vector ' + vecId);
			var masterKey = fb(nonceVectors.control_tweak_vectors[0], 'master_key');
			var input = Buffer.from(vector.input_lines.join('\r\n') + '\r\n', 'ascii');
			var expected = Buffer.concat(fbList(vector, 'expected_wire_lines').map(function(line) {
				return Buffer.concat([line, Buffer.from('\r\n', 'ascii')]);
			}));
			var encrypted = ff1.encryptControlLines(
				input,
				masterKey,
				vector.segment_index,
				fb(vector, 'salt')
			);
			assert.deepEqual(encrypted, expected, vecId);
		});
	});

	it('test-only FF1 decryptor restores the vendored control-line vectors', function() {
		['control-vec-07-full-article-5-lines', 'control-vec-08-full-article-54-lines',
			'control-vec-09-one-byte-data', 'control-vec-10-exact-wrap-article-6-lines',
			'control-vec-11-combined-one-byte-data', 'control-vec-12-single-part-name-contains-part'
		].forEach(function(vecId) {
			var vector = controlVectors.vectors.filter(function(item) {
				return item.id === vecId;
			})[0];
			assert(vector, 'missing vector ' + vecId);
			var masterKey = fb(nonceVectors.control_tweak_vectors[0], 'master_key');
			var block = Buffer.from(vector.input_lines.join('\r\n') + '\r\n', 'ascii');
			var input = Buffer.concat(fbList(vector, 'expected_wire_lines').map(function(line) {
				return Buffer.concat([line, Buffer.from('\r\n', 'ascii')]);
			}));
			var restored = ff1Decrypt.decryptControlLines(input, masterKey);
			assert.deepEqual(restored.block, block, vecId + ' block');
			assert.deepEqual(restored.salt, fb(vector, 'salt'), vecId + ' salt');
			assert.equal(restored.segmentIndex, vector.segment_index, vecId + ' segmentIndex');
		});
	});

	it('uses one alphabet-safe salt for body and control-line encryption', async function() {
		var salt = cryptoCore.generateEncryptionSalt();
		assert.equal(salt.length, 16);
		salt.forEach(function(value) {
			assert(![0, 10, 13].includes(value));
		});
		var key = await cryptoCore.deriveKey('public-conformance-vector-key-2026', salt);
		assert.equal(key.length, 32);
	});

	it('validates segment and line index ranges', function() {
		var key = Buffer.alloc(32);
		assert.throws(function() { cryptoCore.deriveBodyNonce(key, 0); }, /1 to 4294967295/);
		assert.throws(function() { cryptoCore.deriveBodyNonce(key, 4294967296); }, /1 to 4294967295/);
		assert.throws(function() { cryptoCore.deriveControlTweak(key, 1, 0); }, /1 to 4294967295/);
	});

	it('validates 16-byte salt and uint32 range for Line 1 bootstrap prefix', function() {
		var masterKey = Buffer.alloc(32, 1);
		var validSalt = Buffer.alloc(16, 5);
		var line = Buffer.from('=ybegin part=1 total=1 line=128 size=123 name=test', 'ascii');
		// Valid Line 1
		var wire = encryptControlLine(line, masterKey, 1, 1, validSalt);
		assert.equal(wire.length, line.length + 20);
		// Salt length must be exactly 16
		assert.throws(function() { encryptControlLine(line, masterKey, 1, 1, Buffer.alloc(15)); }, /Line 1 requires the 16-byte encryption salt/);
		assert.throws(function() { encryptControlLine(line, masterKey, 1, 1, null); }, /Line 1 requires the 16-byte encryption salt/);
		// Salt must be within Radix 253 alphabet (no 0, 10, 13)
		var badSalt = Buffer.from(validSalt);
		badSalt[0] = 0;
		assert.throws(function() { encryptControlLine(line, masterKey, 1, 1, badSalt); }, /byte outside the Radix 253 alphabet/);
		// Segment index must be valid uint32 >= 1
		assert.throws(function() { encryptControlLine(line, masterKey, 0, 1, validSalt); }, /1 to 4294967295/);
		assert.throws(function() { encryptControlLine(line, masterKey, 4294967296, 1, validSalt); }, /1 to 4294967295/);
	});

	it('skips index-framing-rule forbidden segmentIndex bytes when allocating indices', function() {
		// Index framing rule: uint32_be(segmentIndex) bytes 0x0A/0x0D would split Line 1 on the wire.
		// assign-and-advance semantics: counter initialized at 0, first article gets 1.
		assert.equal(cryptoCore.nextSafeSegmentIndex(0), 1, 'first article receives index 1');

		// canonical index_allocation.json skip vectors
		var indexVectors = require(path.join(vectorsDir, 'index_allocation.json')).vectors;
		indexVectors.forEach(function(vector) {
			assert.equal(cryptoCore.nextSafeSegmentIndex(vector.candidate_index - 1), vector.expected_assigned_index, vector.id);
		});

		// contiguous run across the 265..270 span: 265 -> 267 (266 skipped) -> 268 -> 270 (269 skipped) -> 271
		var span = [];
		var idx = 264;
		for(var i = 0; i < 7; i++) {
			idx = cryptoCore.nextSafeSegmentIndex(idx);
			span.push(idx);
		}
		assert.deepEqual(span, [265, 267, 268, 270, 271, 272, 273], '265..270 span skips 266 and 269');

		assert(cryptoCore.hasForbiddenSegmentIndexByte(10));
		assert(cryptoCore.hasForbiddenSegmentIndexByte(13));
		assert(cryptoCore.hasForbiddenSegmentIndexByte(266));
		assert(cryptoCore.hasForbiddenSegmentIndexByte(269));
		assert(!cryptoCore.hasForbiddenSegmentIndexByte(11));
		assert(!cryptoCore.hasForbiddenSegmentIndexByte(270));
		// a forbidden byte in any of the four positions triggers the skip
		assert(cryptoCore.hasForbiddenSegmentIndexByte(0x0A000000));
		assert(cryptoCore.hasForbiddenSegmentIndexByte(0x000D0000));
	});

	it('rejects forbidden delimiter bytes in segmentIndex when encrypting Line 1', function() {
		var masterKey = Buffer.alloc(32, 1);
		var validSalt = Buffer.alloc(16, 1);
		var line = Buffer.from('=ybegin part=1 total=1 line=128 size=1000 name=test.bin');
		assert.throws(function() {
			encryptControlLine(line, masterKey, 10, 1, validSalt);
		}, /forbidden delimiter bytes/);
		assert.throws(function() {
			encryptControlLine(line, masterKey, 266, 1, validSalt);
		}, /forbidden delimiter bytes/);
	});

	it('exhausts segmentIndex space with an error instead of wrapping to zero', function() {
		assert.throws(function() {
			cryptoCore.nextSafeSegmentIndex(0xFFFFFFFF);
		}, /segmentIndex space exhausted/);
		// the last permitted index is still assignable
		assert.equal(cryptoCore.nextSafeSegmentIndex(0xFFFFFFFE), 0xFFFFFFFF);
	});
});
