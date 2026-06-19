"use strict";

var assert = require("assert");
var ProgressRecorder = require('../cli/progrec');

describe('Progress Recorder', function() {

it('simple test', function(done) {
	var q = new ProgressRecorder(10);
	assert.equal(q.count(), 0);
	q.add(0);
	q.add(1);
	q.add(2);
	q.add(3);
	assert.equal(q.count(), 4);
	assert.equal(q.average(3), 1);
	assert.equal(q.average(4, 1), 1);
	assert.equal(q.average(3, 100), 1);
	
	done();
});

it('simple test 2', function(done) {
	var q = new ProgressRecorder(10);
	q.add(0);
	q.add(1);
	q.add(6);
	assert.equal(q.count(), 3);
	assert.equal(q.average(2), 3);
	assert.equal(q.average(1), 5);
	assert.equal(q.average(1, 6), 3);
	
	done();
});

it('should handle max size', function(done) {
	var q = new ProgressRecorder(2);
	q.add(0);
	q.add(1);
	q.add(6);
	assert.equal(q.count(), 2);
	assert.equal(q.average(2), 5);
	assert.equal(q.average(1), 5);
	
	done();
});

it('should evict samples when maxNum difference is exceeded', function(done) {
	var q = new ProgressRecorder(10, 5);
	q.add(0);
	q.add(1);
	q.add(2);
	assert.equal(q.count(), 3);
	q.add(10);
	assert.equal(q.count(), 3);
	assert.deepEqual(q.samples, [1, 2, 10]);
	
	done();
});

// TODO: more tests

});
