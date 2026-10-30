"use strict";

// UP7-1 (Body Std v1.2): changed-source reload nonce reuse regression.
// Exercises the real scheduler: check-cache eviction (queueCache: 0) releases
// the post, a STAT check failure triggers a reload from the filesystem, and a
// changed same-length source must never be re-encrypted under the original
// nonce (no second POST, error completion). An unchanged source reloads
// byte-identically and the repost succeeds.

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var os = require('os');

var FileUploader = require('../lib/fileuploader');
var NNTPServer = require('./_nntpsrv');
var deepMerge = require('../lib/util').deepMerge;

var lastServerPort = 0;
var clientOpts = function(opts) {
	var o = {};
	deepMerge(o, require('../config'));
	delete o.servers;
	deepMerge(o, {
		server: {
			connect: {
				host: '127.0.0.1',
				port: lastServerPort,
				highWaterMark: 0,
				rejectUnauthorized: false
			},
			secure: false,
			user: 'fixture-user',
			password: 'fixture-' + 'nntp-value',
			timeout: 100,
			connTimeout: 100,
			postTimeout: 150,
			reconnectDelay: 50,
			connectRetries: 1,
			requestRetries: 1,
			postRetries: 1,
			postRetryDelay: 0,
			errorTeardown: false,
			closeTimeout: 10,
			postConnections: 1,
			checkConnections: 1
		},
		check: {
			delay: 10,
			recheckDelay: 10,
			tries: 1,
			ulConnReuse: false,
			postRetries: 1,
			queueCache: 0, // force eviction: released posts must reload from disk
			queueBuffer: 5
		},
		articleSize: 768000,
		postHeaders: {
			Subject: 'test',
			From: 'test@example.test',
			Newsgroups: 'rifles',
			Date: (new Date()).toISOString()
		},
		nzb: null
	});
	deepMerge(o, opts);
	o.servers = [o.server];
	return o;
};
var curServer = null;
var testSkel = function(files, opts, cb) {
	var server = new NNTPServer({});
	curServer = server;
	server.listen(0, function() {
		lastServerPort = server.address().port;
		FileUploader.upload(files, clientOpts(opts), cb);
	});
	return server;
};

// stub uploader sink used to observe the reload callback seam directly
function readErrorSeamTest(done) {
	// uploadmgr's reloadPost must forward read errors through the callback
	// unchanged; verify via a minimal fake stream and the real seam by driving
	// an upload whose source file disappears before the reload.
	var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyuu-reload-'));
	var source = path.join(dir, 'source.bin');
	fs.writeFileSync(source, Buffer.alloc(5, 65));
	testSkel([source], {
		encryptionEnabled: true,
		encryptionPassword: 'pw',
		check: {tries: 1, postRetries: 1}
	}, function(err) {
		// the server drops the post; before the reload the file is removed so
		// readRange reports a read error through the callback
		try {
			assert(err instanceof Error, 'expected upload error after source read failure');
			assert.notEqual(err.code, 'ENC_SOURCE_CHANGED');
			done();
		} catch(e) { done(e); }
	}).onPostHook = function() {
		fs.unlinkSync(source);
		return true; // drop the post, forcing a STAT miss and reload
	};
}

describe('encrypted changed-source reload (UP7-1)', function() {
	this.timeout(30000);
	var dir;

	beforeEach(function() {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyuu-reload-'));
	});

	afterEach(function(done) {
		fs.rmSync(dir, {recursive: true, force: true});
		if(curServer) {
			var s = curServer;
			curServer = null;
			s.close(done);
		} else {
			done();
		}
	});

	it('refuses a changed same-length source after eviction+STAT repost: no second POST, error completion', function(done) {
		var source = path.join(dir, 'source.bin');
		fs.writeFileSync(source, Buffer.alloc(5, 65)); // AAAAA
		var server = testSkel([source], {
			encryptionEnabled: true,
			encryptionPassword: 'pw',
			check: {tries: 1, postRetries: 1}
		}, function(err) {
			try {
				assert(err instanceof Error, 'expected error completion, got success');
				assert(!server.posts.rifles || server.posts.rifles.length === 0, 'no changed article may be posted');
				assert.deepStrictEqual(Object.keys(server.postIdMap), [], 'no changed article may be posted');
				done();
			} catch(e) { done(e); }
		});
		server.onPostHook = function() {
			fs.writeFileSync(source, Buffer.alloc(5, 66)); // BBBBB, same length
			return true; // drop the first post to force STAT-miss reload
		};
	});

	it('reposts byte-identically when the source is unchanged after eviction+STAT repost', function(done) {
		var source = path.join(dir, 'source.bin');
		fs.writeFileSync(source, Buffer.alloc(5, 65));
		var server = testSkel([source], {
			encryptionEnabled: true,
			encryptionPassword: 'pw',
			check: {tries: 1, postRetries: 1}
		}, function(err) {
			try {
				assert.ifError(err);
				assert.equal(Object.keys(server.posts.rifles).length, 1, 'unchanged-source repost must succeed');
				done();
			} catch(e) { done(e); }
		});
		server.onPostHook = function() { return true; }; // drop first post, source untouched
	});

	it('preserves the read-error callback path when the source cannot be reread', readErrorSeamTest);
});
