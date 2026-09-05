"use strict";

var assert = require("assert");
var async = require('async');
var NNTP = require('../lib/nntp');
var net = require('net');

var allocBuffer = (Buffer.allocUnsafe || Buffer);
var toBuffer = (Buffer.alloc ? Buffer.from : Buffer);

// async.waterfall wrapper which checks if callbacks are called more than once
var waterfall = function(funcs, cb) {
	var called = Array(funcs.length);
	async.waterfall(funcs.map(function(f, idx) {
		return function() {
			var args = Array.prototype.slice.call(arguments);
			var cb = args.pop();
			args.push(function() {
				if(called[idx]) throw new Error('async callback called more than once');
				called[idx] = true;
				cb.apply(null, arguments);
			});
			f.apply(null, args);
		};
	}), cb);
};

// mimick Post object as far as the NNTP module requires it
function DummyPost(data) {
	this.data = toBuffer(data);
	this.randomizeMessageID = function() {
		return this.messageId = 'xxxx';
	};
}

var newFakeConn = function() {
	var fakeConn = new (require('stream').Writable)();
	fakeConn.destroy = function() {};
	fakeConn.resume = function() {};
	return fakeConn;
};

var tl = require('./_testlib');

var DEBUG = false;
var TEST_SSL = false;
var TEST_THREADS = 0; // set to num desired threads, though >1 is mostly pointless

// TODO: consider throwing errors on unexpected warnings
var nntpLastLog = {warn: null, info: null, debug: null};
NNTP.log = {
	error: function(msg) {
		if(DEBUG) console.log('[ERROR] ' + msg);
		nntpLastLog.error = msg;
	},
	warn: function(msg) {
		if(DEBUG) console.log('[WARN] ' + msg);
		nntpLastLog.warn = msg;
	},
	info: function(msg) {
		if(DEBUG) console.log('[INFO] ' + msg);
		nntpLastLog.info = msg;
	},
	debug: function(msg) {
		if(DEBUG) console.log('[DEBUG] ' + msg);
		nntpLastLog.debug = msg;
	}
};


// emulate a simple echo/expectation server
function TestServer(onConn) {
	this.data = allocBuffer(0);
	
	var cOpts = {allowHalfOpen: true};
	if(TEST_SSL) {
		var readFile = function(f) {
			return require('fs').readFileSync(__dirname + require('path').sep + f)
		};
		cOpts = {
			key: readFile('_ssl.key'),
			cert: readFile('_ssl.crt'),
		};
	}
	
	this.server = require(TEST_SSL ? 'tls' : 'net').createServer(cOpts, function(c) {
		if(this._conn) throw new Error('Multiple connections received');
		this._conn = c;
		this.connCount++;
		this.connectedTime = Date.now();
		c.on('data', this.onData.bind(this));
		c.on('error', function(err) {
			// we do expect errors - log them for now?
			if(err.code != 'EPIPE')
				console.log('Test-server error: ', err);
		});
		c.once('close', function() {
			this._conn = null;
		}.bind(this));
		c.once('end', function() {
			if(this.autoClose)
				this._conn.end();
		}.bind(this));
		c.setNoDelay(); // make tests a little faster
		onConn();
	}.bind(this));
}
TestServer.prototype = {
	_expect: null,
	_expectAction: null,
	_conn: null,
	_closed: false,
	connCount: 0,
	autoClose: true,
	
	onData: function(chunk) {
		if(!this._expect && this._expect !== '') throw new Error('Unexpected data received: ' + chunk.toString());
		
		if(DEBUG) console.log('<< ' + chunk.toString());
		
		// highly inefficient, but meh
		this.data = Buffer.concat([this.data, chunk]);
		
		if(this.data.length > this._expect.length)
			assert.equal(this.data.toString(), this._expect.toString());
		if(this.data.length == this._expect.length) {
			assert.equal(this.data.toString(), this._expect.toString());
			this._expect = null;
			this.data = allocBuffer(0);
			if(typeof this._expectAction == 'function')
				this._expectAction.call(this);
			else if(this._expectAction || this._expectAction === '')
				this.respond(this._expectAction);
		}
	},
	expect: function(data, response) {
		this._expect = toBuffer(data);
		this._expectAction = response;
	},
	respond: function(msg) {
		this._conn.write(msg);
		this._conn.write('\r\n');
		if(DEBUG) console.log('>> ' + msg.toString());
	},
	close: function(cb) {
		if(!this._closed)
			this.server.close(cb);
		else
			process.nextTick(cb);
		this._closed = true;
	},
	disconnect: function() {
		this._conn.end();
	},
	drop: function() {
		this._conn.destroy();
		this._conn = null;
	},
	listen: function(port, cb) {
		this._closed = false;
		this.server.listen(port, '127.0.0.1', function() {
			lastServerPort = this.server.address().port;
			cb();
		}.bind(this));
	}
};

var deepMerge = require('../lib/util').deepMerge;

if(TEST_THREADS)
	require('../lib/sockthread').createPool(TEST_THREADS);

var currentServer;
var lastServerPort = 1; // hopefully invalid port
var newNNTP = function(opts) {
	var o = { // connection settings
		connect: {
			host: '127.0.0.1',
			port: lastServerPort,
			highWaterMark: 0,
			rejectUnauthorized: false
		},
		useThreads: !!TEST_THREADS,
		secure: TEST_SSL,
		user: null,
		password: null,
		timeout: 75,
		connTimeout: 500, // timeout is higher than the reconnect delay - a test relies on it
		postTimeout: 150,
		reconnectDelay: 300,
		connectRetries: 1,
		requestRetries: 5,
		postRetries: 1,
		postRetryDelay: 0,
		errorTeardown: false,
		closeTimeout: 10,
		keepAlive: false
	};
	deepMerge(o, opts);
	return new NNTP(o);
};
function killServer(cb) {
	cb = cb || function(){};
	if(!currentServer) return cb();
	try {
		currentServer.close(function() {
			currentServer = null;
			lastServerPort = 1;
			cb();
		});
		return;
	} catch(x) { cb(); } // failed to close, just continue...
}
function setupTest(o, cb) {
	nntpLastLog = {warn: null, info: null, debug: null};
	
	lastServerPort = 1;
	if(currentServer) { // previous test failed?
		killServer(setupTest.bind(null, o, cb));
		return;
	}
	
	if(!cb) {
		cb = o;
		o = null;
	}
	
	var server = new TestServer(function() {
		server.respond('200 host test server');
	});
	server.listen(0, function() {
		cb(null, server, newNNTP(o));
	});
	currentServer = server;
}

function setupAuth(client, server, cb) {
	client.opts.user = 'nyuu';
	client.opts.password = 'iamreallylucy';
	server.expect('AUTHINFO USER nyuu\r\n', function() {
		assert.equal(client.state, 'authenticating');
		this.respond('381 Give AUTHINFO PASS command');
		this.expect('AUTHINFO PASS iamreallylucy\r\n', function() {
			this.respond('281 User logged in');
			if(cb) cb();
		});
	});
}

var endClient = function(client, cb, ef) {
	var called = false;
	ef = ef || 'end';
	client[ef](function() {
		if(called) throw new Error('client.end callback called twice');
		called = true;
		assert.equal(client.state, 'inactive');
		if(cb) cb();
	});
};

function closeTest(client, server, cb) {
	if(client.state == 'disconnected' || client.state == 'inactive') {
		server.close(cb);
		killServer();
	} else {
		server.expect('QUIT\r\n', '205 Connection closing');
		endClient(client);
		assert.equal(client.state, 'closing');
		tl.defer(function() {
			assert.equal(client.state, 'inactive');
			assert.equal(client._requests.length, 0);
			server.close(cb);
			killServer();
		});
	}
	
}


describe('NNTP Client', function() {

it('should handle basic tasks', function(done) {
	
	var server, client;
	var date1set = false;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			// this tests a pipelined DATE request
			server.expect('DATE\r\nDATE\r\n', '111 20100204060810\r\n111 20110204060810');
			client.date(tl.fn1(function(err, date) {
				assert(!err);
				assert.equal(date.toString(), (new Date('2010-02-04 06:08:10')).toString());
				date1set = true;
			}));
			client.date(cb);
		},
		function(date, cb) {
			assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
			assert(date1set);
			
			server.expect('GROUP some-group\r\n', '211 2 1 2 some-group');
			client.group('some-group', cb);
		},
		function(cb) {
			assert.equal(client.currentGroup, 'some-group');
			
			server.expect('GROUP invalid-group\r\n', '411 No such newsgroup (Mailbox does not exist)');
			client.group('invalid-group', function(err) {
				assert.equal(err.code, 'invalid_group');
				assert.equal(client.currentGroup, 'some-group');
				cb();
			});
		},
		function(cb) {
			server.expect('STAT <valid-post>\r\n', '223 51 <valid-post> article retrieved - request text separately');
			client.stat('valid-post', cb);
		},
		function(a, cb) {
			assert.equal(a[0], 51);
			assert.equal(a[1], 'valid-post');
			
			server.expect('STAT <invalid-post>\r\n', '430 no such article found');
			client.stat('invalid-post', cb);
		},
		function(a, cb) {
			assert(!a);
			
			server.expect('STAT 3311\r\n', '223 3311 <a-random-post> article retrieved - request text separately');
			client.stat(3311, cb);
		},
		function(a, cb) {
			assert.equal(a[0], 3311);
			assert.equal(a[1], 'a-random-post');
			
			// test posting
			var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
			server.expect('POST\r\n', function() {
				this.expect(msg, '240 <new-article> Article received ok');
				this.respond('340  Send article');
			});
			client.post(new DummyPost(msg), cb);
		},
		function(a, cb) {
			assert.equal(a, 'new-article');
			
			cb();
		},
		function(cb) {
			closeTest(client, server, cb);
		}
	], done);
});

it('should handle XREPLIC posting', function(done) {
	var server, client, mathRandom;
	waterfall([
		setupTest.bind(null, {postMethod: 'XREPLIC'}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
			
			// hack the Math.random function to ensure exact results
			mathRandom = Math.random;
			Math.random = function() { return 0.5; }
		},
		function(cb) {
			var msg = 'Newsgroups: a.b.group\r\n\r\nNyuu breaks free again!\r\n.\r\n';
			
			assert.equal(client.state, 'connected');
			
			server.expect('XREPLIC a.b.group:1073741823\r\n', function() {
				this.expect(msg, '235 Article transferred OK');
				this.respond('335 Send it');
			});
			var post = new DummyPost(msg);
			post.getHeader = function(str) {
				if(str.toLowerCase() == 'newsgroups')
					return 'a.b.group';
				return null;
			};
			client.post(post, function(err, a) {
				assert.equal(a, 'xxxx');
				cb();
			});
		},
		function(cb) {
			Math.random = mathRandom;
			closeTest(client, server, cb);
		}
	], done);
});
it('should handle TAKETHIS posting', function(done) {
	var server, client, mathRandom;
	waterfall([
		setupTest.bind(null, {postMethod: 'TAKETHIS', postRetries: 0}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			var msg = 'Newsgroups: a.b.group\r\n\r\nNyuu breaks free again!\r\n.\r\n';
			
			assert.equal(client.state, 'connected');
			
			server.expect('TAKETHIS <xxxx>\r\n'+msg, function() {
				this.respond('239 <new-article>');
			});
			client.post(new DummyPost(msg), function(err, a) {
				assert.equal(a, 'new-article');
				cb();
			});
		},
		/* uncomment when TAKETHIS pipelining is supported
		function(cb) {
			var rc = 0;
			// test pipelining posts, since TAKETHIS is the only method where we support post pipelining
			var msg1 = 'X-Info: post1\r\n\r\nNyuu breaks free again!\r\n.\r\n';
			var msg2 = 'X-Info: post2\r\n\r\nNyuu breaks free again!\r\n.\r\n';
			
			server.expect('TAKETHIS <xxxx>\r\n'+msg1+'TAKETHIS <xxxx>\r\n'+msg2, function() {
				this.respond('239 <post1>\r\n439 <post2>\r\n');
			});
			client.post(new DummyPost(msg1), function(err, a) {
				assert.equals(rc++, 0);
				assert.equal(a, 'post1');
			});
			client.post(new DummyPost(msg2), function(err, a) {
				assert.equals(rc++, 1);
				assert.equal(err.code, 'post_denied');
				cb();
			});
		},
		*/
		function(cb) {
			closeTest(client, server, cb);
		}
	], done);
});


it('should be able to pipeline a post after a stat', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			var rc = 0;
			var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
			
			assert.equal(client.state, 'connected');
			
			server.expect('STAT <valid-post>\r\nPOST\r\n', function() {
				this.expect(msg, '240 <new-article> Article received ok');
				this.respond('223 51 <valid-post> article retrieved - request text separately\r\n340  Send article');
			});
			// TODO: consider testing the post with a post-timeout-hack enabled
			client.stat('valid-post', tl.fn1(function(err, a) {
				assert.equal(rc++, 0);
				assert.equal(a[0], 51);
				assert.equal(a[1], 'valid-post');
			}));
			client.post(new DummyPost(msg), function(err, a) {
				assert.equal(rc++, 1);
				assert.equal(a, 'new-article');
				cb();
			});
		},
		function(cb) {
			closeTest(client, server, cb);
		}
	], done);
});


it('should auto-connect on request', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			server.expect('DATE\r\n', '111 20110204060810');
			client.date(cb);
		},
		function(date, cb) {
			assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
			assert.equal(client.state, 'connected');
			
			closeTest(client, server, cb);
		}
	], done);
});

it('should honour a request made before connected', function(done) {
	var server, client;
	var date1set = false;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			
			server.expect('DATE\r\nDATE\r\n', '111 20100204060810\r\n111 20110204060810');
			client.connect();
			client.date(tl.fn1(function(err, date) {
				assert(!err);
				assert.equal(date.toString(), (new Date('2010-02-04 06:08:10')).toString());
				date1set = true;
			}));
			client.date(cb);
		},
		function(date, cb) {
			assert(date1set);
			assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
			assert.equal(client.state, 'connected');
			closeTest(client, server, cb);
		}
	], done);
});

it('should authenticate', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			setupAuth(client, server);
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			closeTest(client, server, cb);
		}
	], done);
});

it('should end when requested'); // also test .destroy() method
['end','close'].forEach(function(ef) {
	// also check that the 'end' event is received by the server, but not 'close'
	// also check for correct timings if the server actually ends the connection
	it('should destroy if '+ef+' timeout exceeded');
	
	// this isn't much of a test, since errors after end/close should largely be discarded
	// it's mostly to ensure that no exceptions get thrown
	it('should deal with socket errors after '+ef+' called', function(done) {
		var server, client;
		waterfall([
			setupTest,
			function(_server, _client, cb) {
				server = _server;
				client = _client;
				client.connect(cb);
			},
			function(cb) {
				assert.equal(client.state, 'connected');
				if(ef == 'end')
					server.expect('QUIT\r\n', '205 Connection closing');
				client[ef](function() {
					assert.equal(client.state, 'inactive');
					cb();
				});
				client.socket.emit('error', new Error('test error'));
			},
			function(cb) {
				closeTest(client, server, cb);
			}
		], done);
	});
	
	it('should handle ' + ef + '() whilst error-closing', function(done) {
		var server, client;
		waterfall([
			setupTest.bind(null, {closeTimeout: 100}),
			function(_server, _client, cb) {
				server = _server;
				client = _client;
				
				client.connect(function(err) {
					assert.equal(client.state, 'connected');
					
					// test a double-close - both should get the callback without waiting for the close timeout
					var s = Date.now();
					server.expect('QUIT\r\n');
					client._close(function() {
						tl.assertTimeWithin(s, 0, 20);
					});
					client[ef](function() {
						tl.assertTimeWithin(s, 0, 20);
						setTimeout(cb, 200); // wait to see if the timeout gets fired
					});
				});
			},
			function(cb) {
				closeTest(client, server, cb);
			}
		], done);
	});
	it('should handle ' + ef + '() whilst error-closing (reverse order)', function(done) {
		var server, client;
		waterfall([
			setupTest.bind(null, {closeTimeout: 100}),
			function(_server, _client, cb) {
				server = _server;
				client = _client;
				
				client.connect(function(err) {
					assert.equal(client.state, 'connected');
					
					// test a double-close - both should get the callback without waiting for the close timeout
					var s = Date.now();
					server.expect('QUIT\r\n');
					client[ef](function() {
						tl.assertTimeWithin(s, 0, 20);
					});
					client._close(function() {
						tl.assertTimeWithin(s, 0, 20);
						setTimeout(cb, 200); // wait to see if the timeout gets fired
					});
				});
			},
			function(cb) {
				closeTest(client, server, cb);
			}
		], done);
	});
});

it('should call all end/close callbacks when closed');

it('should not connect if destroyed straight after', function(done) {
	var server, client;
	var cancelled = false;
	waterfall([
		killServer,
		function(cb) {
			var _server = new TestServer(function() {
				throw new Error('Client connected');
			});
			_server.listen(0, function() {
				cb(null, _server, newNNTP());
			});
			currentServer = _server;
		},
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(function(err) {
				assert.equal(err.code, 'cancelled');
				cancelled = true;
			});
			client.destroy();
			tl.defer(cb);
		},
		function(cb) {
			assert.equal(client.state, 'inactive');
			assert(cancelled);
			closeTest(client, server, cb);
		}
	], done);
});

['end','close','destroy'].forEach(function(ef) {
	it('should notify cancellation + kill reconnect if ' + ef + '() during connect retry wait', function(done) {
		waterfall([
			killServer,
			function(cb) {
				var client = newNNTP();
				client.connect(function(err) {
					assert.equal(err.code, 'cancelled');
					assert.equal(client.state, 'inactive');
					cb();
				});
				// this is triggered to run whilst the reconnect timeout is running
				setTimeout(function() {
					if(ef == 'destroy')
						client.destroy();
					else
						endClient(client, null, ef);
				}, 100);
			}
		], done);
	});
	
	it('should notify cancellation if ' + ef + '() whilst connecting', function(done) {
		var server, client;
		
		// simulate a connection timeout by hijacking the connect method, so that it does nothing on the first call
		var net = require('net');
		var realConnect = net.connect;
		net.connect = function() {
			net.connect = realConnect;
			return newFakeConn();
		};
		
		waterfall([
			setupTest.bind(null, {connectRetries: 2, connTimeout: 100, closeTimeout: 150}),
			function(_server, _client, cb) {
				server = _server;
				client = _client;
				
				var s = Date.now();
				client.connect(function(err) {
					assert.equal(err.code, 'cancelled');
					assert.equal(client.state, 'inactive');
					tl.assertTimeWithin(s, 0, 50); // shouldn't wait for timeout
					setTimeout(cb, 250); // wait to see if the timeout gets fired
				});
				setImmediate(function() {
					// end the connection whilst it's still connecting
					endClient(client, null, ef);
				});
			},
			function(cb) {
				closeTest(client, server, cb);
			}
		], done);
	});
});

it('should notify cancellation if cancelled during authentication', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.opts.user = 'nyuu';
			client.opts.password = 'iamreallylucy';
			
			server.expect('AUTHINFO USER nyuu\r\n', function() {
				assert.equal(client.state, 'authenticating');
				client.destroy();
				assert.equal(client.state, 'inactive');
			});
			client.connect(function(err) {
				assert.equal(err.code, 'cancelled');
				cb();
			});
		},
		function(cb) {
			tl.defer(function() {
				server.close(cb);
				killServer();
				assert.equal(client.state, 'inactive');
			});
		}
	], done);
});

[
	{msg: 'half-open end request', noResp: '', req: 'date', ef: 'end'}, // this test seems to fail with SSL enabled; maybe node has slightly different semantics with calling .end() and not receiving data afterwards
	{msg: 'half-open end request', noResp: 'no-resp', req: 'date', ef: 'end'},
	{msg: 'half-open end request', noResp: 'close-timeout', req: 'date', ef: 'end'},
	{msg: 'half-open end pipelined request', noResp: '', req: 'date2', ef: 'end'},
	{msg: 'half-open end pipelined request', noResp: 'no-resp', req: 'date2', ef: 'end'},
	{msg: 'half-open end pipelined request', noResp: 'close-timeout', req: 'date2', ef: 'end'},
	{msg: 'half-open close request', noResp: '', req: 'date', ef: 'close'},
	{msg: 'half-open close request', noResp: 'no-resp', req: 'date', ef: 'close'},
	{msg: 'half-open close request', noResp: 'close-timeout', req: 'date', ef: 'close'},
	{msg: 'half-open close pipelined request', noResp: '', req: 'date2', ef: 'close'},
	{msg: 'half-open close pipelined request', noResp: 'no-resp', req: 'date2', ef: 'close'},
	{msg: 'half-open close pipelined request', noResp: 'close-timeout', req: 'date2', ef: 'close'},
	{msg: 'close request during post', noResp: '', req: 'post', ef: 'close'},
	{msg: 'close request during post', noResp: 'no-resp', req: 'post', ef: 'close'},
	{msg: 'close request during post', noResp: 'close-timeout', req: 'post', ef: 'close'}
].forEach(function(test) {
	it('should handle ' + test.msg + (test.noResp ? ' ('+test.noResp+')' : ''), function(done) {
		var server, client;
		waterfall([
			setupTest.bind(null, {timeout: 5000, closeTimeout: 50}),
			function(_server, _client, cb) {
				server = _server;
				if(test.noResp == 'close-timeout') server.autoClose = false;
				client = _client;
				client.connect(cb);
			},
			function(cb) {
				assert.equal(client.state, 'connected');
				
				// request something and immediately end - response should still come back
				if(test.req == 'date' || test.req == 'date2') {
					server.expect('DATE\r\n' + (test.req == 'date2' ? 'DATE\r\n':'') + (test.ef == 'end' ? 'QUIT\r\n':''), function() {
						if(!test.noResp) {
							setImmediate(function() {
								server.respond('111 20110204060810' + (test.req == 'date2' ? '\r\n111 20110204060810':''));
								if(test.ef == 'end')
									server.respond('205 Connection closing');
							});
						} else {
							// do nothing so that client times out
							// TODO: check that client doesn't attempt to reconnect
						}
					});
					var called = 0;
					var respCb = function(err, date) {
						if(test.ef == 'close') {
							assert.equal(err.code, 'cancelled');
							assert(!date);
						} else if(!test.noResp) {
							assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
						} else {
							assert.equal(err.code, 'cancelled');
							assert(!date);
							//assert.equal(client.state, 'disconnected');
						}
					};
					
					if(test.req == 'date2') {
						client.date(tl.fn1(function(err, date) {
							assert.equal(called++, 0);
							respCb(err, date);
						}));
					} else {
						called++;
					}
					client.date(function(err, date) {
						assert.equal(called++, 1);
						respCb(err, date);
						cb();
					});
				}
				if(test.req == 'post') {
					var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
					server.expect('POST\r\n' + (test.ef == 'end' ? 'QUIT\r\n':''), function() {
						if(!test.noResp) {
							this.respond('340  Send article');
							if(test.ef == 'end')
								server.respond('205 Connection closing');
						}
					});
					client.post(new DummyPost(msg), function(err, a) {
						if(test.ef == 'close') {
							assert.equal(err.code, 'cancelled');
							assert(!a);
						} else {
							// TODO: support this??
						}
						cb();
					});
				}
				endClient(client, null, test.ef);
				assert.equal(client.state, 'closing');
			},
			function(cb) {
				tl.defer(function() {
					server.close(cb);
					if(test.noResp == 'close-timeout') server.disconnect();
					killServer();
					assert.equal(client.state, 'inactive');
					assert.equal(client._requests.length, 0);
				});
			}
		], done);
	});
});

['normal', 'delay-close', 'no-resp'].forEach(function(mode) {
	var ef = 'close';
	it('should handle close request during post upload (' + mode + ')', function(done) {
		var server, client;
		waterfall([
			setupTest,
			function(_server, _client, cb) {
				server = _server;
				client = _client;
				client.connect(cb);
			},
			function(cb) {
				assert.equal(client.state, 'connected');
				
				var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
				server.expect('POST\r\n' + (ef == 'end' ? 'QUIT\r\n':''), function() {
					this.expect(msg, function() {
						if(mode == 'no-resp') {
							this.respond('240 <new-article> Article received ok');
							if(ef == 'end')
								server.respond('205 Connection closing');
						}
					});
					this.respond('340  Send article');
					var cl = function() {
						endClient(client, null, ef);
						assert.equal(client.state, 'closing');
					};
					if(mode == 'delay-close')
						setTimeout(cl, 20);
					else
						cl();
				});
				client.post(new DummyPost(msg), function(err, a) {
					if(ef == 'close') {
						assert.equal(err.code, 'cancelled');
						//assert(!a);
					} else {
						// TODO: support this??
					}
					cb();
				});
			},
			function(cb) {
				tl.defer(function() {
					server.close(cb);
					killServer();
					assert.equal(client.state, 'inactive');
				});
			}
		], done);
		
	});
});

[{resp: true, ef: 'end'}, {resp: false, ef: 'end'},
 {resp: true, ef: 'close'}, {resp: false, ef: 'close'}].forEach(function(t) {
	it(t.ef + ' request during auth' + (t.resp ? '':' (error)'), function(done) {
		var server, client;
		waterfall([
			setupTest,
			function(_server, _client, cb) {
				server = _server;
				client = _client;
				client.opts.user = 'nyuu';
				client.opts.password = 'iamreallylucy';
				
				server.expect('AUTHINFO USER nyuu\r\n', function() {
					assert.equal(client.state, 'authenticating');
					endClient(client, null, t.ef);
					assert.equal(client.state, 'closing');
					if(t.ef == 'end')
						server.expect('QUIT\r\n');
					if(t.resp) {
						server.respond('381 Give AUTHINFO PASS command');
					}
				});
				client.connect(function(err) {
					assert.equal(err.code, 'cancelled'); // we don't distinguish between a response being given or not for .end requests during connection setup
					cb();
				});
			},
			function(cb) {
				tl.defer(function() {
					server.close(cb);
					killServer();
					assert.equal(client.state, 'inactive');
				});
			}
		], done);
	});
});

it('should not honor half-open destroy request', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			server.expect('DATE\r\n', function() {
				setImmediate(function() {
					if(!server._conn) return;
					server._conn.once('error', function(){}); // suppress EPIPE error
					server.respond('111 20110204060810');
				});
			});
			client.date(tl.fn1(function(err) {
				assert.equal(err.code, 'cancelled');
			}));
			client.destroy();
			assert.equal(client.state, 'inactive');
			tl.defer(function() {
				server.close(cb);
				killServer();
			});
		}
	], done);
});

it('should handle connection drop just before request', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			server.drop();
			server.expect('DATE\r\n', '111 20110204060810');
			client.date(cb);
		},
		function(date, cb) {
			assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
			closeTest(client, server, cb);
		}
	], done);
});

it('should deal with error responses');
it('should deal with invalid responses'); // including onconnect

it('should attempt to reconnect if connection is lost (keepalive=1)', function(done) {
	var server, client;
	waterfall([
		setupTest.bind(null, {keepAlive: true}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			setupAuth(client, server);
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			server.drop();
			setupAuth(client, server, function() {
				tl.defer(cb);
			});
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			closeTest(client, server, cb);
		}
	], done);
	
});
it('should attempt to rejoin a group if connection is lost (keepalive=1)', function(done) {
	var server, client;
	waterfall([
		setupTest.bind(null, {keepAlive: true}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			setupAuth(client, server);
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			server.expect('GROUP some-group\r\n', '211 2 1 2 some-group');
			client.group('some-group', cb);
		},
		function(cb) {
			assert.equal(client.currentGroup, 'some-group');
			
			server.drop();
			setupAuth(client, server, function() {
				server.expect('GROUP some-group\r\n', function() {
					this.respond('211 2 1 2 some-group');
					tl.defer(cb);
				});
			});
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			closeTest(client, server, cb);
		}
	], done);
});
it('should attempt to reconnect if connection is lost after new request (keepalive=0)', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			setupAuth(client, server);
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			server.drop();
			tl.defer(function() {
				assert.equal(client.state, 'inactive');
				client.stat(1, cb);
				setupAuth(client, server, function() {
					server.expect('STAT 1\r\n', '223 1 <some-post> article retrieved');
				});
			});
		},
		function(a, cb) {
			assert.equal(client.state, 'connected');
			assert.equal(a[0], 1);
			assert.equal(a[1], 'some-post');
			
			closeTest(client, server, cb);
		}
	], done);
});
it('should attempt to rejoin a group if connection is lost after new request (keepalive=0)', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			setupAuth(client, server);
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			server.expect('GROUP some-group\r\n', '211 2 1 2 some-group');
			client.group('some-group', cb);
		},
		function(cb) {
			assert.equal(client.currentGroup, 'some-group');
			
			server.drop();
			tl.defer(function() {
				assert.equal(client.state, 'inactive');
				client.stat(1, cb);
				setupAuth(client, server, function() {
					server.expect('GROUP some-group\r\n', function() {
						server.expect('STAT 1\r\n', '223 1 <some-post> article retrieved');
						this.respond('211 2 1 2 some-group');
					});
				});
			});
		},
		function(a, cb) {
			assert.equal(client.state, 'connected');
			assert.equal(a[0], 1);
			assert.equal(a[1], 'some-post');
			
			closeTest(client, server, cb);
		}
	], done);
});


it('should clear receive buffer on connection dropout');
it('should disconnect if response received exceeds 4KB in size');

it('should resend request if connection lost before response received', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			server.expect('GROUP some-group\r\n', '211 2 1 2 some-group');
			client.group('some-group', cb);
		},
		function(cb) {
			assert.equal(client.currentGroup, 'some-group');
			
			// send req
			server.expect('DATE\r\n', function() {
				this.expect('GROUP some-group\r\n', function() {
					this.expect('DATE\r\n', '111 20110204060810');
					this.respond('211 2 1 2 some-group');
				});
				this.drop();
			});
			client.date(cb);
		},
		function(date, cb) {
			assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
			
			closeTest(client, server, cb);
		}
	], done);
});
['post','post-upload'].forEach(function(test) {
	it('should reattempt to post if connection drops out (during '+test+')', function(done) {
		var server, client;
		waterfall([
			setupTest.bind(null, {uploadChunkSize: 1}),
			function(_server, _client, cb) {
				server = _server;
				client = _client;
				client.connect(cb);
			},
			function(cb) {
				assert.equal(client.state, 'connected');
				
				var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
				server.expect('POST\r\n', function() {
					var doRetryAction = function() {
						server.expect('POST\r\n', function() {
							this.expect(msg, '240 <new-article> Article received ok');
							this.respond('340  Send article');
						});
						// we'll hijack this test case to check that the input buffer gets cleared on reconnect, by sending some junk data
						server._conn.write('blah'); // should be ignored by client
						setTimeout(function() {
							server.drop();
						}, 30);
					};
					if(test == 'post-upload') {
						this.expect(msg, doRetryAction);
						this.respond('340  Send article');
					} else {
						doRetryAction();
					}
				});
				client.post(new DummyPost(msg), cb);
			},
			function(a, cb) {
				assert.equal(a, 'new-article');
				
				closeTest(client, server, cb);
			}
		], done);
	});
});

[true, false].forEach(function(serverHasIt) {
	it('should STAT before re-posting if connection drops out during upload (article ' + (serverHasIt ? 'accepted' : 'missing') + ')', function(done) {
		var server, client;
		waterfall([
			setupTest.bind(null, {uploadChunkSize: 1, checkBeforeRepost: true}),
			function(_server, _client, cb) {
				server = _server;
				client = _client;
				client.connect(cb);
			},
			function(cb) {
				assert.equal(client.state, 'connected');
				
				var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
				server.expect('POST\r\n', function() {
					this.expect(msg, function() {
						// article fully sent, drop before acknowledging it
						server.expect('STAT <xxxx>\r\n', function() {
							if(serverHasIt) {
								// server has it: no second upload may follow
								this.respond('223 0 <xxxx> article retrieved - request text separately');
							} else {
								this.expect('POST\r\n', function() {
									this.expect(msg, '240 <new-article> Article received ok');
									this.respond('340  Send article');
								});
								this.respond('430 No article with that message-id');
							}
						});
						setTimeout(function() {
							server.drop();
						}, 30);
					});
					this.respond('340  Send article');
				});
				client.post(new DummyPost(msg), cb);
			},
			function(a, cb) {
				assert.equal(a, serverHasIt ? 'xxxx' : 'new-article');
				assert.equal(server.connCount, 2);
				
				closeTest(client, server, cb);
			}
		], done);
	});
});
it('should not STAT if connection drops out before the article is sent', function(done) {
	var server, client;
	waterfall([
		setupTest.bind(null, {checkBeforeRepost: true}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
			server.expect('POST\r\n', function() {
				server.expect('POST\r\n', function() {
					this.expect(msg, '240 <new-article> Article received ok');
					this.respond('340  Send article');
				});
				server.drop();
			});
			client.post(new DummyPost(msg), cb);
		},
		function(a, cb) {
			assert.equal(a, 'new-article');
			closeTest(client, server, cb);
		}
	], done);
});

[false, true].forEach(function(reconn) {
	it('should '+(reconn?'reconnect':'retry')+' on first post failure', function(done) {
		var server, client;
		waterfall([
			setupTest.bind(null, {
				postFailReconnect: reconn
			}),
			function(_server, _client, cb) {
				server = _server;
				client = _client;
				client.connect(cb);
			},
			function(cb) {
				assert.equal(client.state, 'connected');
				
				var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
				server.expect('POST\r\n', function() {
					this.expect(msg, function() {
						this.expect('POST\r\n', function() {
							this.expect(msg, '240 <new-article> Article received ok');
							assert.equal(this.connCount, reconn?2:1);
							this.respond('340 Send article');
						});
						assert.equal(this.connCount, 1);
						this.respond('441 posting failed');
					});
					this.respond('340 Send article');
				});
				client.post(new DummyPost(msg), cb);
			},
			function(a, cb) {
				assert.equal(a, 'new-article');
				
				closeTest(client, server, cb);
			}
		], done);
		
	});
});

it('should resend request if connection lost and reconnect fails once', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.currentGroup = 'some-group';
			server.expect('GROUP some-group\r\n', '211 2 1 2 some-group');
			client.connect(cb);
		},
		function(cb) {
			// send req
			server.expect('DATE\r\n', function() {
				this.expect('GROUP some-group\r\n', function() {
					this.expect('GROUP some-group\r\n', function() {
						this.expect('DATE\r\n', '111 20110204060810');
						this.respond('211 2 1 2 some-group');
					});
					this.drop(); // drop a second time (this will be in the connect init sequence)
				});
				this.drop(); // drop first time
			});
			client.date(cb);
		},
		function(date, cb) {
			assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
			
			closeTest(client, server, cb);
		}
	], done);
});


it('should retry on request timeout', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			server.expect('DATE\r\n', function() {
				// never give a response...
				// give one on second try
				server.expect('DATE\r\n', '111 20110204060810');
			});
			client.date(cb);
		},
		function(date, cb) {
			assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
			closeTest(client, server, cb);
		}
	], done);
	
});
it('should retry on request timeout (3x pipeline)', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			server.expect('DATE\r\nDATE\r\nDATE\r\n', function() {
				// respond to only one request, ignore other two, which should be tried again
				server.expect('DATE\r\nDATE\r\n', '111 20120204060810\r\n111 20130204060810');
				
				server.respond('111 20110204060810');
			});
			
			var called = 0;
			client.date(tl.fn1(function(err, date) {
				assert.equal(called++, 0);
				assert(!err);
				assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
			}));
			client.date(tl.fn1(function(err, date) {
				assert.equal(called++, 1);
				assert(!err);
				assert.equal(date.toString(), (new Date('2012-02-04 06:08:10')).toString());
			}));
			client.date(function(err, date) {
				assert.equal(called++, 2);
				assert(!err);
				assert.equal(date.toString(), (new Date('2013-02-04 06:08:10')).toString());
				cb();
			});
		},
		function(cb) {
			closeTest(client, server, cb);
		}
	], done);
});

it('should send timeout errors to pipelined requests', function(done) {
	var server, client;
	waterfall([
		setupTest.bind(null, {requestRetries: 0}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			server.expect('DATE\r\nDATE\r\n', function() {
				// don't respond -> timeout error
				// the second request will be resent though...
				server.expect('DATE\r\n', function() {
					server.drop();
				});
			});
			
			var called = 0;
			client.date(tl.fn1(function(err, date) {
				assert.equal(called++, 0);
				assert.equal(err.code, 'timeout');
				assert(!date);
			}));
			client.date(function(err, date) {
				assert.equal(called++, 1);
				assert.equal(err.code, 'connection_lost');
				assert(!date);
				cb();
			});
		},
		function(cb) {
			closeTest(client, server, cb);
		}
	], done);
});

it('check timeout timing of pipelined requests', function(done) {
	var server, client;
	waterfall([
		setupTest.bind(null, {requestRetries: 0, timeout: 200}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			var t = Date.now();
			server.expect('DATE\r\nDATE\r\n', function() {
				// don't respond -> timeout error
				tl.assertTimeWithin(t, 100);
				server.expect('DATE\r\n'); // expected 2nd request
			});
			
			var called = 0;
			client.date(tl.fn1(function(err, date) {
				assert.equal(called++, 0);
				tl.assertTimeWithin(t, 200, 300); // timeout delay, but less than timeout + second request delay
				assert.equal(err.code, 'timeout');
				assert(!date);
			}));
			setTimeout(function() {
				client.date(function(err, date) {
					assert.equal(called++, 1);
					// the first timeout should trigger a reconnect, resetting the second timeout, so total time should be > 2*timeout
					tl.assertTimeWithin(t, 400);
					assert.equal(err.code, 'timeout');
					assert(!date);
					cb();
				});
			}, 100);
		},
		function(cb) {
			var t = Date.now();
			server.expect('DATE\r\nDATE\r\n', function() {
				// respond to only one
				this.respond('111 20110204060810');
			});
			
			var called = 0;
			client.date(tl.fn1(function(err, date) {
				assert.equal(called++, 0);
				assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
			}));
			setTimeout(function() {
				client.date(function(err, date) {
					assert.equal(called++, 1);
					tl.assertTimeWithin(t, 300, 400); // timeout + second request delay, but less than 2*timeout
					assert.equal(err.code, 'timeout');
					assert(!date);
					cb();
				});
			}, 100);
		},
		function(cb) {
			closeTest(client, server, cb);
		}
	], done);
});


it('should retry on posting timeout', function(done) {
	var server, client;
	waterfall([
		setupTest.bind(null, {postTimeout: 100000}), // test that we hit the request timeout, not the upload timeout
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
			server.expect('POST\r\n', function() {
				this.expect(msg, function() {
					// never give a response...
					// give one on second try
					this.expect('POST\r\n', function() {
						this.expect(msg, '240 <new-article> Article received ok');
						this.respond('340  Send article');
					});
				});
				this.respond('340  Send article');
			});
			client.post(new DummyPost(msg), cb);
		},
		function(a, cb) {
			assert.equal(a, 'new-article');
			closeTest(client, server, cb);
		}
	], done);
});

it('should report upload timeouts', function(done) {
	var server, client;
	waterfall([
		setupTest.bind(null, {
			postTimeout: 300,
			timeout: 100000, // test that we hit upload timeouts, not request timeouts
			requestRetries: 0,
			uploadChunkSize: 1048576 // this seems to increase the likelihood of upload stalls
		}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			var msg = ' ';
			// make a large enough message to exhaust Node's internal buffers (4MB doesn't seem to work on node v0.10, but 8MB seems fine) so that pausing actually works
			for(var i=0; i<24; i++)
				msg += msg;
			msg = 'My-Secret: not telling\r\n\r\n' + msg + '\r\n.\r\n';
			server.expect('POST\r\n', function() {
				this._conn.pause(); // try to not accept any data
				this.respond('340  Send article');
				
				// don't respond and hope for an upload timeout
			});
			client.post(new DummyPost(msg), function(err, a) {
				assert.equal(err.code, 'timeout');
				process.nextTick(function() { // in current code, state is 'disconnected' now, and gets switched to 'inactive' a bit later
					assert.equal(client.state, 'inactive');
					cb();
				});
			});
		},
		function(cb) {
			server.drop(); // drop any client connection
			closeTest(client, server, cb);
		}
	], done);
});

it('should ignore posting timeout if requested', function(done) {
	var server, client;
	waterfall([
		setupTest.bind(null, {onPostTimeout: ['ignore']}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
			server.expect('POST\r\n', function() {
				this.expect(msg, function() {
					// never give a response...
				});
				this.respond('340  Send article');
			});
			client.post(new DummyPost(msg), cb);
		},
		function(a, cb) {
			assert.equal(a, 'xxxx');
			closeTest(client, server, cb);
		}
	], done);
});

it('should retry posting if timeout occurred and timeouts are to be ignored', function(done) {
	var server, client;
	waterfall([
		setupTest.bind(null, {onPostTimeout: ['ignore']}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
			server.expect('POST\r\n', function() {
				// don't respond - timeout should occur and post be retried
				
				this.expect('POST\r\n', function() {
					assert.equal(this.connCount, 2);
					this.expect(msg, '240 <new-article> Article received ok');
					this.respond('340  Send article');
				});
			});
			client.post(new DummyPost(msg), cb);
		},
		function(a, cb) {
			assert.equal(a, 'new-article');
			closeTest(client, server, cb);
		}
	], done);
});

it('should handle server responding early during chunked post upload', function(done) {
	var server, client;
	var sendNextChunks = 0;
	waterfall([
		setupTest.bind(null, {retryBadResp: true, requestRetries: 1, uploadChunkSize: 4, throttle: function(cost, cb) {
			if(sendNextChunks) {
				cb();
				sendNextChunks--;
			}
		}}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			var msg = 'X:b\r\n\r\nm\r\n.\r\n';
			server.expect('POST\r\n', function() {
				// respond after only receiving first chunk
				this.expect(msg.substring(0, 4), function() {
					this.expect('POST\r\n', function() { // expect a re-post attempt
						this.expect(msg.substring(0, 4), '240 <new-article> Article received ok');
						sendNextChunks = 1;
						this.respond('340  Send article');
					});
					this.respond('240 <new-article> Article received ok');
				});
				sendNextChunks = 1;
				this.respond('340  Send article');
			});
			client.post(new DummyPost(msg), function(err) {
				assert.equal(err.code, 'post_interrupted');
				assert(client.state == 'inactive' || client.state == 'disconnected');
				cb();
			});
		},
		function(cb) {
			closeTest(client, server, cb);
		}
	], done);
});

it('should handle disconnect during chunked post upload, and retry', function(done) {
	var server, client;
	var sendNextChunks = 0;
	waterfall([
		setupTest.bind(null, {closeTimeout: 5000 /*should never trigger*/, uploadChunkSize: 4, throttle: function(cost, cb) {
			if(sendNextChunks) {
				cb();
				sendNextChunks--;
			}
		}}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			var msg = 'X:b\r\n\r\nm\r\n.\r\n';
			server.expect('POST\r\n', function() {
				this.expect(msg.substring(0, 4), function() {
					this.expect('POST\r\n', function() {
						sendNextChunks = 10;
						this.expect(msg, '240 <new-article> Article received ok');
						this.respond('340  Send article');
					});
					this.disconnect();
				});
				sendNextChunks = 1;
				this.respond('340  Send article');
			});
			client.post(new DummyPost(msg), cb);
		},
		function(a, cb) {
			assert.equal(a, 'new-article');
			closeTest(client, server, cb);
		}
	], done);
});

// TODO: support .end when we add support for ending whilst posting
['close','destroy'].forEach(function(ef) {
	it('should handle '+ef+' request during chunked post upload', function(done) {
		var server, client;
		var sendNextChunks = 0;
		var gotPostCb = 0, gotCancel = 0;
		waterfall([
			setupTest.bind(null, {closeTimeout: 5000 /*should never trigger*/, uploadChunkSize: 4, throttle: function(cost, cb) {
				if(sendNextChunks) {
					cb();
					sendNextChunks--;
				}
				var cancelObj = function(){};
				cancelObj.cancel = function() {
					gotCancel++;
					cb(true);
				};
				return cancelObj;
			}}),
			function(_server, _client, cb) {
				server = _server;
				client = _client;
				client.connect(cb);
			},
			function(cb) {
				assert.equal(client.state, 'connected');
				
				var msg = 'X:b\r\n\r\nm\r\n.\r\n';
				server.expect('POST\r\n', function() {
					this.expect(msg.substring(0, 4), function() {
						if(ef == 'destroy') {
							client.destroy();
							tl.defer(cb);
						} else {
							client[ef](function() {
								tl.defer(cb);
							});
						}
					});
					sendNextChunks = 1;
					this.respond('340  Send article');
				});
				client.post(new DummyPost(msg), function(err) {
					gotPostCb++;
					assert.equal(err.code, 'cancelled');
				});
			},
			function(cb) {
				assert.equal(gotPostCb, 1);
				assert.equal(gotCancel, 1);
				closeTest(client, server, cb);
			}
		], done);
	});
});

it('should return error if reconnect completely fails during a request', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			server.close(); // reject all future connect attempts
			currentServer = null;
			// send req
			server.expect('DATE\r\nDATE\r\n', function() {
				this.expect('DATE\r\nDATE\r\n', '111 20110204060810\r\n111 20120204060810');
				this.drop();
			});
			var called = 0;
			client.date(tl.fn1(function(err, date) {
				assert.equal(called++, 0);
				assert(!date);
				assert.equal(err.code, 'connect_fail');
				assert.equal(client.state, 'inactive');
			}));
			client.date(function(err, date) {
				assert.equal(called++, 1);
				assert(!date);
				assert.equal(err.code, 'connect_fail');
				assert.equal(client.state, 'inactive');
				cb();
			});
		},
		function(cb) {
			closeTest(client, server, cb);
		}
	], done);
});
it('should return auth fail if connection drops during a request and reconnect fails auth', function(done) {
	var server, client;
	waterfall([
		setupTest.bind(null, {connectRetries: 0}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			setupAuth(client, server);
			client.connect(cb);
		},
		function(cb) {
			// send req
			server.expect('POST\r\n', function() {
				server.expect('AUTHINFO USER nyuu\r\n', function() {
					assert.equal(client.state, 'authenticating');
					this.expect('AUTHINFO PASS iamreallylucy\r\n', function() {
						this.respond('482 Too many connections');
					});
					this.respond('381 Give AUTHINFO PASS command');
				});
				this.disconnect();
			});
			client.post(new DummyPost('a'), tl.fn1(function(err, messageId) {
				assert(!messageId);
				assert.equal(err.code, 'connect_fail');
				assert.equal(client.state, 'inactive');
				cb();
			}));
		},
		function(cb) {
			closeTest(client, server, cb);
		}
	], done);
});

it('should work if requesting whilst disconnected without pending connect', function(done) {
	var server, client;
	waterfall([
		setupTest.bind(null, {connTimeout: 20, connectRetries: 1, reconnectDelay: 10}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			server.close(); // reject all future connect attempts
			server.drop();
			currentServer = null;
			
			// wait after all reconnect attempts have been tried
			setTimeout(function() {
				assert.equal(client.state, 'inactive');
				server.listen(lastServerPort, cb);
			}, 100);
		},
		function(cb) {
			server.expect('DATE\r\nDATE\r\n', '111 20110204060810\r\n111 20120204060810');
			var called = 0;
			client.date(tl.fn1(function(err, date) {
				assert.equal(called++, 0);
				assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
				assert.equal(client.state, 'connected');
			}));
			client.date(tl.fn1(function(err, date) {
				assert.equal(called++, 1);
				assert.equal(date.toString(), (new Date('2012-02-04 06:08:10')).toString());
				assert.equal(client.state, 'connected');
				closeTest(client, server, cb);
			}));
			assert.equal(client.state, 'connecting');
		}
	], done);
});

it('should deal with connection timeouts', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			// simulate a connection timeout by hijacking the connect method, so that it does nothing on the first call
			var realConnect = client.connectSocket;
			client.connectSocket = function() {
				client.connectSocket = realConnect;
				return newFakeConn();
			};
			
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			closeTest(client, server, cb);
		}
	], done);
});
it('should not gracefully close connection on connection timeouts', function(done) {
	var server, client;
	
	// simulate a connection timeout by hijacking the connect method, so that it does nothing on the first call
	var net = require('net');
	var realConnect = net.connect;
	net.connect = function() {
		net.connect = realConnect;
		return newFakeConn();
	};
	
	waterfall([
		setupTest.bind(null, {connectRetries: 0, connTimeout: 100, closeTimeout: 200}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			
			var s = Date.now();
			client.connect(function(err) {
				assert.equal(err.code, 'connect_fail');
				assert.equal(client.state, 'inactive');
				tl.assertTimeWithin(s, 100, 200); // should wait for connTimeout but not closeTimeout to kick in
				cb();
			});
		},
		function(cb) {
			closeTest(client, server, cb);
		}
	], done);
});
it('should do nothing on an idle too long message');

it('should not wait for close timeout on successful close', function(done) {
	var server, client;
	waterfall([
		setupTest.bind(null, {connectRetries: 0, closeTimeout: 200}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			
			var s = Date.now();
			client.connect(function(err) {
				client.close(function() {
					tl.assertTimeWithin(s, 0, 100);
					cb();
				});
			});
		},
		function(cb) {
			closeTest(client, server, cb);
		}
	], done);
});

it('should retry reconnecting if it only fails once', function(done) {
	var server, client;
	waterfall([
		killServer,
		function(cb) {
			// we don't start a server so that the connect fails, but start it up a while after so that the retry should succeed
			lastServerPort = 53151;
			var server, client = newNNTP();
			var emitted = false;
			var s = Date.now();
			client.connect(function(err) {
				tl.assertTimeWithin(s, 300, 801); // reconnect delay should be 300ms, ...but less than 800ms (delay + timeout)
				assert(server);
				cb(err, server, client);
			});
			setTimeout(function() {
				server = new TestServer(function() {
					server.respond('200 host test server');
				});
				server.listen(lastServerPort, function() {});
				currentServer = server;
				
				if(!client.numErrors)
					client.socket.emit('error', 1); // workaround for systems that take a while to emit the connect fail error
			}, 150);
		},
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			
			server.expect('DATE\r\n', '111 20110204060810');
			client.date(cb);
		},
		function(date, cb) {
			assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
			assert.equal(client.state, 'connected');
			closeTest(client, server, cb);
		}
	], done);
});
it('should retry reconnecting if init sequence fails', function(done) {
	var server, client;
	waterfall([
		killServer,
		function(cb) {
			var dropped = false;
			var s = Date.now();
			var server = new TestServer(function() {
				// first connection = drop, otherwise continue
				if(dropped) {
					tl.assertTimeWithin(s, 300, 801); // reconnect delay should be 300ms ...but less than 800ms (delay + timeout)
					server.respond('200 host test server');
				} else {
					server.drop();
					dropped = true;
				}
			});
			server.listen(0, function() {
				cb(null, server, newNNTP());
			});
			currentServer = server;
		},
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			closeTest(client, server, cb);
		}
	], done);
});
it('should retry on timeout during init sequence', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			
			client.opts.user = 'nyuu';
			client.opts.password = 'iamreallylucy';
			server.expect('AUTHINFO USER nyuu\r\n', function() {
				assert.equal(client.state, 'authenticating');
				this.expect('AUTHINFO PASS iamreallylucy\r\n', function() {
					// do nothing to timeout
					this.expect('AUTHINFO USER nyuu\r\n', function() {
						this.expect('AUTHINFO PASS iamreallylucy\r\n', '281 User logged in');
						this.respond('381 Give AUTHINFO PASS command');
					});
				});
				this.respond('381 Give AUTHINFO PASS command');
			});
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			closeTest(client, server, cb);
		}
	], done);
});
it('should throw error on auth failure');
it('should throw error if selected group fails on connect');

it('test handling of connection failure if init sequence almost completes', function(done) {
	var server, client;
	waterfall([
		killServer,
		function(cb) {
			var dropped = false;
			var s = Date.now();
			var server = new TestServer(function() {
				// first connection = drop right after sending a response, otherwise continue
				if(dropped) {
					tl.assertTimeWithin(s, 300, 801); // reconnect delay should be 300ms ...but less than 800ms (delay + timeout)
					server.respond('200 host test server');
				} else {
					server.respond('200 host test server');
					server.drop();
					dropped = true;
				}
			});
			server.listen(0, function() {
				cb(null, server, newNNTP());
			});
			currentServer = server;
		},
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			closeTest(client, server, cb);
		}
	], done);
});

it('should retry on a single auth failure');

it('should warn on unexpected spurious data received');
it('should deal with unexpected 200 messages by reconnecting (keepalive=1)', function(done) {
	var server, client, ct;
	waterfall([
		setupTest.bind(null, {keepAlive: true}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			ct = server.connectedTime;
			server.expect('STAT 1\r\n', '223 1 <some-post> article retrieved');
			tl.defer(function() {
				client.stat(1, cb);
			});
		},
		function(a, cb) {
			server.respond('200 Welcome');
			// client should now reconnect
			tl.defer(cb);
		}, function(cb) {
			assert.notEqual(server.connectedTime, ct);
			
			closeTest(client, server, cb);
		}
	], done);
});
it('should deal with 200 responses by reconnecting', function(done) {
	var server, client, ct;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			ct = server.connectedTime;
			server.expect('STAT 1\r\n', function() {
				this.expect('STAT 1\r\n', '223 1 <some-post> article retrieved');
				this.respond('200 Welcome'); // client should drop now
			});
			tl.defer(function() {
				client.stat(1, cb);
			});
		},
		function(a, cb) {
			assert.equal(client.state, 'connected');
			assert.equal(a[0], 1);
			assert.notEqual(server.connectedTime, ct);
			
			closeTest(client, server, cb);
		}
	], done);
});
it('should deal with unexpected 200 messages by disconnecting (keepalive=0)', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			server.expect('STAT 1\r\n', '223 1 <some-post> article retrieved');
			tl.defer(function() {
				client.stat(1, cb);
			});
		},
		function(a, cb) {
			server.respond('200 Welcome');
			// client should now disconnect
			tl.defer(cb);
		}, function(cb) {
			assert.equal(client.state, 'inactive');
			
			closeTest(client, server, cb);
		}
	], done);
});

it('should give up after max reconnect retries hit', function(done) {
	var server, client;
	var connectAttempts = 0;
	waterfall([
		killServer,
		function(cb) {
			server = new TestServer(function() {
				connectAttempts++;
				// don't respond, will timeout
			});
			server.listen(0, function() {
				client = newNNTP();
				cb(null);
			});
			currentServer = server;
		},
		function(cb) {
			client.connect(tl.fn1(function(err) {
				tl.defer(function() {
					assert.equal(err.code, 'connect_fail');
					assert.equal(connectAttempts, 2);
					closeTest(client, server, cb);
				});
			}));
		}
	], done);
});
it('should give up after max reconnect retries hit (lazy connect)', function(done) {
	var server, client;
	var connectAttempts = 0;
	waterfall([
		killServer,
		function(cb) {
			server = new TestServer(function() {
				connectAttempts++;
				// don't respond, will timeout
			});
			server.listen(0, function() {
				client = newNNTP();
				cb(null);
			});
			currentServer = server;
		},
		function(cb) {
			client.date(tl.fn1(function(err) {
				tl.defer(function() {
					assert.equal(err.code, 'connect_fail');
					assert.equal(connectAttempts, 2);
					closeTest(client, server, cb);
				});
			}));
		}
	], done);
});
// TODO: ^ also test that this reconnect counter is reset after a successful connect

it('should give up after max request retries hit', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			var allDone = false;
			server.expect('STAT 1\r\n', function() {
				async.timesSeries(5, function(n, cb) {
					server.expect('STAT 1\r\n', cb);
					server.drop();
				}, function(err) {
					if(err) throw err;
					allDone = true;
				});
			});
			client.stat(1, function(err) {
				assert(allDone);
				assert.equal(err.code, 'timeout');
				cb();
			});
		}, function(cb) {
			closeTest(client, server, cb);
		}
	], done);
});
['post','post-upload'].forEach(function(test) {
	it('should give up after max request retries hit ('+test+' timeout)', function(done) {
		var server, client;
		waterfall([
			setupTest,
			function(_server, _client, cb) {
				server = _server;
				client = _client;
				client.connect(cb);
			},
			function(cb) {
				var allDone = false;
				var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
				async.timesSeries(6, function(n, cb) {
					if(test == 'post-upload') {
						server.expect('POST\r\n', function() {
							this.expect(msg, cb);
							this.respond('340  Send article');
						});
					} else {
						server.expect('POST\r\n', cb);
					}
				}, function(err) {
					if(err) throw err;
					allDone = true;
				});
				client.post(new DummyPost(msg), function(err, messageId) {
					assert.equal(err.code, 'timeout');
					if(test == 'post-upload')
						assert(messageId); // should still return the message-id because we accepted the POST request
					assert(allDone);
					cb();
				});
			}, function(cb) {
				closeTest(client, server, cb);
			}
		], done);
	});
});
it('should give up after max post retries hit');

it('should fail on badly formed responses', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			server.expect('DATE\r\n', '100 derp');
			client.date(function(err) {
				assert.equal(err.code, 'bad_response');
				cb();
			});
		},
		function(cb) {
			server.expect('DATE\r\nDATE\r\n', '\r\n000');
			client.date(tl.fn1(function(err) {
				assert.equal(err.code, 'invalid_response');
			}));
			client.date(function(err) {
				assert.equal(err.code, 'invalid_response');
				cb();
			});
		},
		function(cb) {
			server.expect('POST\r\n', '133 ');
			client.post(new DummyPost('abc'), function(err) {
				assert.equal(err.code, 'bad_response');
				cb();
			});
		},
		function(cb) {
			// test posting
			var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
			server.expect('POST\r\n', function() {
				this.expect(msg, '');
				this.respond('340  Send article');
			});
			client.post(new DummyPost(msg), function(err) {
				assert.equal(err.code, 'invalid_response');
				cb();
			});
		},
		function(cb) {
			closeTest(client, server, cb);
		}
	], done);
});
it('should retry on badly formed responses if requested', function(done) {
	var server, client;
	waterfall([
		setupTest.bind(null, {
			requestRetries: 1,
			retryBadResp: true
		}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			server.expect('DATE\r\n', function() {
				this.expect('DATE\r\n', '111 20100204060810');
				this.respond('100 derp');
			});
			client.date(function(err, date) {
				assert(!err);
				assert.equal(date.toString(), (new Date('2010-02-04 06:08:10')).toString());
				cb();
			});
		},
		function(cb) {
			server.expect('DATE\r\nDATE\r\n', function() {
				this.expect('DATE\r\nDATE\r\n', '111 20100204060810\r\n111 20100204060810');
				this.respond('\r\n111 20000204060801');
			});
			client.date(tl.fn1(function(err, date) {
				assert(!err);
				assert.equal(date.toString(), (new Date('2010-02-04 06:08:10')).toString());
			}));
			client.date(function(err, date) {
				assert(!err);
				assert.equal(date.toString(), (new Date('2010-02-04 06:08:10')).toString());
				cb();
			});
		},
		function(cb) {
			// test failure
			server.expect('POST\r\n', function() {
				this.expect('POST\r\n', '133 ');
				this.respond('133 ');
			});
			client.post(new DummyPost('abc'), function(err) {
				assert.equal(err.code, 'bad_response');
				cb();
			});
		},
		function(cb) {
			// test posting
			var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
			server.expect('POST\r\n', function() {
				this.expect(msg, function() {
					this.expect('POST\r\n', function() {
						this.expect(msg, '240 <new-article> Article received ok');
						this.respond('340  Send article');
					});
					this.respond('');
				});
				this.respond('340  Send article');
			});
			client.post(new DummyPost(msg), function(err, a) {
				assert(!err);
				assert.equal(a, 'new-article');
				cb();
			});
		},
		function(cb) {
			closeTest(client, server, cb);
		}
	], done);
});

it('should handle requests after a fatal post-upload failure', function(done) {
	var server, client;
	waterfall([
		setupTest.bind(null, {postRetries: 0, requestRetries: 0}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			var allDone = false;
			var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
			server.expect('POST\r\n', function() {
				this.expect(msg, function() {
					this.expect('DATE\r\n', '111 20110204060810');
					this.respond('444 bad response');
					// TODO: check that the client disconnects after receiving this response
				});
				this.respond('340  Send article');
			});
			client.post(new DummyPost(msg), function(err, messageId) {
				assert.equal(err.code, 'unknown_error');
				client.date(cb);
			});
		}, function(date, cb) {
			assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
			closeTest(client, server, cb);
		}
	], done);
});

it('should deal with a connection drop after receiving partial data');
it('should deal with the case of newlines being split across packets'); // or in unfortunate positions

it('should deal with socket errors');
it('should deal with a socket error during connect');
// TODO: connect() callback shouldn't be called on first error?

// TODO: consider testing recoverability after an error occurrence?
// - i.e. finished=true marked, but another request made, which causes a reconnect and resets everything

// TODO: test onPostTimeout hacks

});
