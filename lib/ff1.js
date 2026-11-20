"use strict";

var crypto = require('crypto');
var deriveControlKey = require('./crypto').deriveControlKey;
var deriveControlTweak = require('./crypto').deriveControlTweak;
var hasForbiddenSegmentIndexByte = require('./crypto').hasForbiddenSegmentIndexByte;

var RADIX = 253;

function byteToNumeral(value) {
	if(value >= 1 && value <= 9) return value - 1;
	if(value === 11) return 9;
	if(value === 12) return 10;
	if(value >= 14 && value <= 255) return value - 3;
	throw new RangeError('Control line contains a byte outside the Radix 253 alphabet');
}

function numeralToByte(value) {
	if(value >= 0 && value <= 8) return value + 1;
	if(value === 9) return 11;
	if(value === 10) return 12;
	if(value >= 11 && value <= 252) return value + 3;
	throw new RangeError('Invalid Radix 253 numeral');
}

function numeralsToBigInt(numerals) {
	var result = 0n;
	for(var i = 0; i < numerals.length; i++)
		result = result * BigInt(RADIX) + BigInt(numerals[i]);
	return result;
}

function bigIntToNumerals(value, length) {
	var result = new Array(length);
	for(var i = length - 1; i >= 0; i--) {
		result[i] = Number(value % BigInt(RADIX));
		value /= BigInt(RADIX);
	}
	return result;
}

function bigIntToBuffer(value, length) {
	var result = Buffer.alloc(length);
	for(var i = length - 1; i >= 0; i--) {
		result[i] = Number(value & 255n);
		value >>= 8n;
	}
	if(value !== 0n)
		throw new RangeError('FF1 integer does not fit the requested buffer');
	return result;
}

// FF1's PRF chains E(result ^ block) over a zero block, which is exactly
// AES-256-CBC with a zero IV - a single cipher allocation instead of one
// createCipheriv per block
var ZERO_BLOCK = Buffer.alloc(16);

function xorBlocks(left, right) {
	var result = Buffer.allocUnsafe(16);
	for(var i = 0; i < 16; i++) result[i] = left[i] ^ right[i];
	return result;
}

function prf(key, data) {
	var cipher = crypto.createCipheriv('aes-256-cbc', key, ZERO_BLOCK);
	cipher.setAutoPadding(false);
	var out = cipher.update(data);
	cipher.final();
	// the PRF result is the last chained block
	return Buffer.from(out.subarray(out.length - 16));
}

function ff1EncryptNumerals(key, tweak, numerals) {
	if(!Array.isArray(numerals) || numerals.length < 2)
		throw new RangeError('FF1 input must contain at least two numerals');
	var n = numerals.length;
	var t = tweak.length;
	var u = Math.floor(n / 2);
	var v = n - u;
	var b = Math.ceil(Math.ceil(v * Math.log2(RADIX)) / 8);
	var d = 4 * Math.ceil(b / 4) + 4;
	var p = Buffer.alloc(16);
	p[0] = 1;
	p[1] = 2;
	p[2] = 1;
	p.writeUIntBE(RADIX, 3, 3);
	p[6] = 10;
	p[7] = u % 256;
	p.writeUInt32BE(n, 8);
	p.writeUInt32BE(t, 12);
	var padding = (16 - ((t + b + 1) % 16)) % 16;
	var qPrefix = Buffer.concat([tweak, Buffer.alloc(padding)]);
	var a = numerals.slice(0, u);
	var second = numerals.slice(u);

	for(var round = 0; round < 10; round++) {
		var q = Buffer.concat([qPrefix, Buffer.from([round]), bigIntToBuffer(numeralsToBigInt(second), b)]);
		var r = prf(key, Buffer.concat([p, q]));
		// S-block expansion: S = R || E(R ^ [1]16) || E(R ^ [2]16) || ...
		// each block is an independent ECB encryption, so they're batched
		// through a single cipher allocation in one update()
		var s = Buffer.from(r);
		var blockCount = Math.ceil((d - 16) / 16);
		if(blockCount > 0) {
			var blockInput = [];
			for(var j = 1; j <= blockCount; j++)
				blockInput.push(xorBlocks(r, bigIntToBuffer(BigInt(j), 16)));
			var expCipher = crypto.createCipheriv('aes-256-ecb', key, null);
			expCipher.setAutoPadding(false);
			var expanded = Buffer.concat([expCipher.update(Buffer.concat(blockInput)), expCipher.final()]);
			s = Buffer.concat([s, expanded]);
		}
		var y = BigInt('0x' + s.subarray(0, d).toString('hex'));
		var m = round % 2 === 0 ? u : v;
		var modulus = BigInt(RADIX) ** BigInt(m);
		var c = (numeralsToBigInt(a) + y) % modulus;
		var next = bigIntToNumerals(c, m);
		a = second;
		second = next;
	}
	return a.concat(second);
}

function encryptControlLine(line, masterKey, segmentIndex, lineIndex, salt) {
	if(!Buffer.isBuffer(line)) line = Buffer.from(line);
	var numerals = Array.prototype.map.call(line, byteToNumeral);
	var key = deriveControlKey(masterKey);
	var tweak = deriveControlTweak(masterKey, segmentIndex, lineIndex);
	var ciphertext = Buffer.from(ff1EncryptNumerals(key, tweak, numerals).map(numeralToByte));
	if(lineIndex !== 1) return ciphertext;
	if(!Buffer.isBuffer(salt) || salt.length !== 16)
		throw new RangeError('Line 1 requires the 16-byte encryption salt');
	for(var i = 0; i < salt.length; i++) byteToNumeral(salt[i]);
	if(!Number.isSafeInteger(segmentIndex) || segmentIndex < 1 || segmentIndex > 4294967295)
		throw new RangeError('segmentIndex must be an integer from 1 to 4294967295');
	if(hasForbiddenSegmentIndexByte(segmentIndex))
		throw new RangeError('segmentIndex contains forbidden delimiter bytes (0x0A or 0x0D)');
	var indexBuf = Buffer.allocUnsafe(4);
	indexBuf.writeUInt32BE(segmentIndex, 0);
	return Buffer.concat([salt, indexBuf, ciphertext]);
}

function splitLines(block) {
	var lines = [];
	var start = 0;
	for(var i = 0; i < block.length; i++) {
		if(block[i] !== 10) continue;
		var contentEnd = i > start && block[i - 1] === 13 ? i - 1 : i;
		lines.push({
			content: block.subarray(start, contentEnd),
			ending: block.subarray(contentEnd, i + 1)
		});
		start = i + 1;
	}
	if(start < block.length)
		lines.push({content: block.subarray(start), ending: Buffer.alloc(0)});
	return lines;
}

function encryptControlLines(block, masterKey, segmentIndex, salt) {
	if(!Buffer.isBuffer(block)) block = Buffer.from(block);
	if(!Buffer.isBuffer(masterKey) || masterKey.length !== 32)
		throw new RangeError('masterKey must be exactly 32 bytes');
	var lines = splitLines(block);
	if(!lines.length || lines[0].content.length < 2 || lines[0].content[0] !== 0x3D || lines[0].content[1] !== 0x79)
		throw new Error('yEnc block must begin with a control line');
	return Buffer.concat(lines.map(function(line, offset) {
		var lineIndex = offset + 1;
		var content = line.content;
		if(content.length >= 2 && content[0] === 0x3D && content[1] === 0x79)
			content = encryptControlLine(content, masterKey, segmentIndex, lineIndex, salt);
		return Buffer.concat([content, line.ending]);
	}));
}

module.exports = {
	encryptControlLines: encryptControlLines
};
