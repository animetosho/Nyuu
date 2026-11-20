"use strict";

var crypto = require('crypto');
var argon2id = require('hash-wasm').argon2id;
var xchacha20poly1305 = require('@noble/ciphers/chacha').xchacha20poly1305;

var BODY_NONCE_PREFIX = Buffer.from('yenc-body nonce', 'ascii');
var BODY_AAD_PREFIX = Buffer.from('yenc-body aad', 'ascii');
var CONTROL_KEY_PREFIX = Buffer.from('yenc-control key', 'ascii');
var CONTROL_TWEAK_PREFIX = Buffer.from('yenc-control tweak', 'ascii');
var MAX_UINT32 = 0xffffffff;

function checkBuffer(value, length, name) {
	if(!Buffer.isBuffer(value) && !(value instanceof Uint8Array))
		throw new TypeError(name + ' must be a byte buffer');
	if(length !== undefined && value.length !== length)
		throw new RangeError(name + ' must be exactly ' + length + ' bytes');
	return Buffer.from(value);
}

function checkIndex(value, name) {
	if(!Number.isSafeInteger(value) || value < 1 || value > MAX_UINT32)
		throw new RangeError(name + ' must be an integer from 1 to 4294967295');
	return value;
}

function uint32Be(value, name) {
	var result = Buffer.allocUnsafe(4);
	result.writeUInt32BE(checkIndex(value, name), 0);
	return result;
}

// Index framing rule: an index whose uint32_be encoding contains 0x0A or 0x0D would split
// the Line 1 bootstrap on the wire and is forbidden (Control Std §4/§8).
function hasForbiddenSegmentIndexByte(index) {
	var bytes = Buffer.allocUnsafe(4);
	bytes.writeUInt32BE(index, 0);
	return bytes[0] === 0x0A || bytes[0] === 0x0D ||
		bytes[1] === 0x0A || bytes[1] === 0x0D ||
		bytes[2] === 0x0A || bytes[2] === 0x0D ||
		bytes[3] === 0x0A || bytes[3] === 0x0D;
}

// Assign-and-advance: returns the next permitted segment index strictly
// greater than `prev`. Initialize the counter at 0 so the first article
// receives index 1. Exhaustion throws instead of wrapping to zero.
function nextSafeSegmentIndex(prev) {
	if(!Number.isSafeInteger(prev) || prev < 0 || prev > MAX_UINT32)
		throw new RangeError('prev segmentIndex must be an integer from 0 to 4294967295');
	var next = prev;
	while(next < MAX_UINT32) {
		next++;
		if(!hasForbiddenSegmentIndexByte(next))
			return next;
	}
	throw new Error('segmentIndex space exhausted: no permitted index greater than ' + prev);
}

function generateSalt() {
	return crypto.randomBytes(16);
}

function generateEncryptionSalt() {
	var salt;
	do {
		salt = generateSalt();
	} while(Array.prototype.some.call(salt, function(value) {
		return value === 0 || value === 10 || value === 13;
	}));
	return salt;
}

async function deriveKey(password, salt) {
	if(typeof password != 'string' && !Buffer.isBuffer(password) && !(password instanceof Uint8Array))
		throw new TypeError('password must be a string or byte buffer');
	if(password.length === 0)
		throw new RangeError('password must not be empty');
	salt = checkBuffer(salt, 16, 'salt');
	var result = await argon2id({
		password: password,
		salt: salt,
		iterations: 1,
		memorySize: 65536,
		parallelism: 4,
		hashLength: 32,
		outputType: 'binary'
	});
	return Buffer.from(result);
}

function deriveBodyNonce(key, segmentIndex) {
	key = checkBuffer(key, 32, 'key');
	var input = Buffer.concat([BODY_NONCE_PREFIX, uint32Be(segmentIndex, 'segmentIndex')]);
	return crypto.createHmac('sha256', key).update(input).digest().subarray(0, 24);
}

function deriveControlKey(masterKey) {
	masterKey = checkBuffer(masterKey, 32, 'masterKey');
	return crypto.createHmac('sha256', masterKey).update(CONTROL_KEY_PREFIX).digest();
}

function deriveControlTweak(masterKey, segmentIndex, lineIndex) {
	masterKey = checkBuffer(masterKey, 32, 'masterKey');
	var input = Buffer.concat([
		CONTROL_TWEAK_PREFIX,
		uint32Be(segmentIndex, 'segmentIndex'),
		uint32Be(lineIndex, 'lineIndex')
	]);
	return crypto.createHmac('sha256', masterKey).update(input).digest().subarray(0, 8);
}

function buildBodyAad(partNumber, partBegin, segmentBytes, name) {
	var nameBuf = Buffer.isBuffer(name) ? name : Buffer.from(name, 'utf8');
	if(nameBuf.length === 0)
		throw new RangeError('AAD name must not be empty');
	var aad = Buffer.allocUnsafe(33 + nameBuf.length);
	BODY_AAD_PREFIX.copy(aad, 0);
	aad.writeUInt32BE(checkIndex(partNumber, 'partNumber'), 13);
	aad.writeUInt32BE(checkIndex(partBegin, 'partBegin'), 17);
	aad.writeBigUInt64BE(BigInt(segmentBytes), 21);
	aad.writeUInt32BE(nameBuf.length, 29);
	nameBuf.copy(aad, 33);
	return aad;
}

function encryptBody(plaintext, key, segmentIndex, aad) {
	plaintext = checkBuffer(plaintext, undefined, 'plaintext');
	key = checkBuffer(key, 32, 'key');
	if(!aad)
		throw new TypeError('aad is required');
	aad = checkBuffer(aad, undefined, 'aad');
	var nonce = deriveBodyNonce(key, segmentIndex);
	var cipher = xchacha20poly1305(key, nonce, aad);
	var sealed = Buffer.from(cipher.encrypt(plaintext));
	return {
		ciphertext: sealed.subarray(0, sealed.length - 16),
		tag: sealed.subarray(sealed.length - 16)
	};
}

module.exports = {
	buildBodyAad: buildBodyAad,
	deriveBodyNonce: deriveBodyNonce,
	deriveControlKey: deriveControlKey,
	deriveControlTweak: deriveControlTweak,
	deriveKey: deriveKey,
	encryptBody: encryptBody,
	generateEncryptionSalt: generateEncryptionSalt,
	hasForbiddenSegmentIndexByte: hasForbiddenSegmentIndexByte,
	nextSafeSegmentIndex: nextSafeSegmentIndex
};
