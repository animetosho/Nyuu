"use strict";

var assert = require("assert");
var argParser = require('../cli/arg_parser');

describe('Argument Parser', function() {

	describe('parseObject bool handling', function() {
		var opts = {
			verbose: {type: 'bool'}
		};

		it('should parse "true" as true', function() {
			assert.strictEqual(argParser.parseObject({verbose: 'true'}, opts).verbose, true);
		});

		it('should parse "1" as true', function() {
			assert.strictEqual(argParser.parseObject({verbose: '1'}, opts).verbose, true);
		});

		it('should parse "false" as false', function() {
			assert.strictEqual(argParser.parseObject({verbose: 'false'}, opts).verbose, false);
		});

		it('should parse "0" as false', function() {
			assert.strictEqual(argParser.parseObject({verbose: '0'}, opts).verbose, false);
		});

		it('should parse "" as false', function() {
			assert.strictEqual(argParser.parseObject({verbose: ''}, opts).verbose, false);
		});

		it('should reject invalid bool strings', function() {
			assert.throws(function() {
				argParser.parseObject({verbose: 'yes'}, opts);
			}, /Invalid value/);
		});

		it('should reject "no" as bool', function() {
			assert.throws(function() {
				argParser.parseObject({verbose: 'no'}, opts);
			}, /Invalid value/);
		});
	});

	describe('parseObject defaults', function() {
		it('should apply default of 0', function() {
			var opts = {
				count: {type: 'int', default: 0}
			};
			assert.strictEqual(argParser.parseObject({}, opts).count, 0);
		});

		it('should apply default of false', function() {
			var opts = {
				flag: {type: 'bool', default: false}
			};
			assert.strictEqual(argParser.parseObject({}, opts).flag, false);
		});

		it('should apply default of empty string', function() {
			var opts = {
				name: {type: 'string', default: ''}
			};
			assert.strictEqual(argParser.parseObject({}, opts).name, '');
		});

		it('should not override provided value', function() {
			var opts = {
				count: {type: 'int', default: 0}
			};
			assert.strictEqual(argParser.parseObject({count: '5'}, opts).count, 5);
		});
	});

});
