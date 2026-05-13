"use strict";

var tls, net, netStub;
var async = require('async');
var util = require('./util');
var Timer = require('./timeoutwrap');

var bufferSlice = Buffer.prototype.readBigInt64BE ? Buffer.prototype.subarray : Buffer.prototype.slice;

var RE_LINE = /^(\d\d\d) (.*)\r\n$/;
var RE_DATE = /^(\d\d\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/;
var RE_GROUP = /^(\d+) (\d+) (\d+) (.*)$/;
var RE_STAT = /^(\d+) <(.*?)>/;
var RE_POST = /^<(.*)>/i;
var MAX_RECV_SIZE = 16384; // 16KB should be *plenty* of space for a response

var CMD_POST, CMD_DATE, CMD_QUIT;
if(Buffer.alloc) {
	CMD_POST = Buffer.from('POST\r\n', 'ascii');
	CMD_DATE = Buffer.from('DATE\r\n', 'ascii');
	CMD_QUIT = Buffer.from('QUIT\r\n', 'ascii');
} else {
	CMD_POST = new Buffer('POST\r\n', 'ascii');
	CMD_DATE = new Buffer('DATE\r\n', 'ascii');
	CMD_QUIT = new Buffer('QUIT\r\n', 'ascii');
}

var VALID_POST_CODES = {
	POST: 240,
	IHAVE: 235,
	XREPLIC: 235,
	TAKETHIS: 239 // TODO: no intermediary step
};
var FAILED_POST_CODES = {
	POST: [441],
	IHAVE: [436, 437],
	XREPLIC: [436, 437],
	TAKETHIS: [439]
};

var checkExpect = function(expected, name, code, info) {
	if(code != expected)
		return new NNTPError('bad_response', 'Unexpected response to '+name+' (code: ' + code + '): ' + info);
};
var noThrottle = function(cost, cb) { cb(); };

function NNTPError(code, message) {
	var r = Error.call(this, message);
	r.name = 'NNTPError';
	r.code = code;
	r.message = message;
	return r;
}
NNTPError.prototype = Object.create(Error.prototype, {
	constructor: NNTPError
});

function NNTPReq(func, msg, type, validResp, cb) {
	this.func = func;
	this.cbParent = cb;
	this.msg = msg;
	this.type = type;
	this.validResp = validResp;
}
NNTPReq.prototype = {
	tries: 0,
	postTimeouts: 0,
	postRetries: 0,
	postRetryDelay: 0,
	post: null,
	ts: 0,
	size: null,
	cb: null, // direct callback that the data handler calls
	cbParent: null, // parent callback that this request resolves
	errVal: null,
	err: function(err) {
		this.cbParent(err, this.errVal);
	}
};

function NNTP(opts, rawSpeedTracker) {
	this.opts = opts;
	this.dataQueue = [];
	this.dataLength = 0;
	this._connectRetries = opts.connectRetries;
	
	var connectOpts = util.extend({
		readableHighWaterMark: 0, // disable buffering
		writableHighWaterMark: 1 // Node 20 seems to go wonky with a value of 0, so use 1 instead
	}, opts.connect);
	// although the feature was added in node 12.10.0, it's crashy on Linux until 13.13.0 / 12.16.3
	// reported as unstable on 15.7.0, so we'll disable it everywhere until we get more info on it: https://github.com/animetosho/Nyuu/issues/87
	var supportsOnread = false;
	if(supportsOnread)
		connectOpts.onread = this.opts.useThreads ? true : {
			buffer: Buffer.allocUnsafe(4096),
			callback: this._onDataStatic.bind(this)
		};
	if(!connectOpts.port)
		connectOpts.port = opts.secure ? 563 : 119;
	if(+process.version.replace(/\.\d+$/, '').replace(/^v/, '') < 8.4) // Node < 8.4.0
		connectOpts.highWaterMark = 0;
	
	
	this.postMethod = (opts.postMethod || '').toUpperCase();
	if(!(this.postMethod in VALID_POST_CODES))
		this.postMethod = 'POST';
	
	// pre-generate this to avoid needing to do this for each post
	this._postValidResp = [VALID_POST_CODES[this.postMethod]];
	if(!opts.postFailReconnect)
		this._postValidResp = this._postValidResp.concat(FAILED_POST_CODES[this.postMethod]);
	
	
	if(this.opts.useThreads) {
		this.connectSocket = (netStub || (netStub = require('./sockthread'))).create.bind(null, this.opts);
	} else {
		if(this.opts.secure) {
			this.connectSocket = (tls || (tls = require('tls'))).connect.bind(null, connectOpts);
		} else {
			this.connectSocket = (net || (net = require('net'))).connect.bind(null, connectOpts);
		}
	}
	if(this.opts.throttle) this.throttle = this.opts.throttle;
	this._onCloseCb = []; // callbacks for .end/.close
	this._closeWaitCb = []; // callbacks for ._end
	this._requests = [];
	this.rawSpeedTracker = rawSpeedTracker;
	this.numErrors = {};
	this.numRequests = {};
	
	this._boundOnConnectFail = this._onConnectFail.bind(this);
	this._boundOnClose = this._onClose.bind(this);
	this._boundOnData = this._onData.bind(this);
	this._boundOnError = this._onError.bind(this);
}

NNTP.prototype = {
	state: 'inactive',
	stateCause: 'unused',
	socket: null,
	postMethod: 'POST',
	_timer: null,
	_immediate: null,
	_throttleHandle: null,
	_finished: false,
	_onCloseCb: null,
	_closeWaitCb: null,
	_requests: null,
	_isPosting: false,
	_respFunc: null,
	_lastError: null,
	_warnedIdDiff: false,
	_connectCb: null,
	canPost: true, // assume true by default (needed if posting before connected)
	currentGroup: null,
	// stats
	bytesRecv: 0,
	bytesSent: 0,
	numConnects: 0,
	numErrors: null,
	numRequests: null,
	lastActivity: 0,
	lastConnectedStart: null,
	lastIdleStart: null,
	connectedTime: 0,
	idleTime: 0,
	// for tracking raw upload speed
	rawSpeedTracker: null,
	reqBytesSent: 0,
	_onDrainListener: null,
	throttle: noThrottle,
	
	_defaultConnectCb: function(err) {
		if(!err) return;
		if(NNTP.log && err.code != 'cancelled')
			NNTP.log.error(err.message);
	},
	
	connect: function(cb) {
		if(this.socket || this.state == 'connecting') throw new Error('Cannot call connect twice');
		this._setState('connecting');
		this._lastError = null;
		this._finished = false;
		this._isPosting = false;
		
		// clear the data queue just in case (shouldn't be necessary as it's cleared on close)
		this.dataQueue = [];
		this.dataLength = 0;
		
		this.numConnects++;
		this._connectCb = cb;
		
		this._clearTimer(); // if request timer is active, clear it
		
		if(this.opts.connTimeout)
			this._setTimer('connect', this._onConnectFail.bind(this, new NNTPError('connect_timeout', 'Connect timed out')), this.opts.connTimeout);
		
		var self = this;
		async.waterfall([
			function(cb) {
				if(self._finished) return cb(null, null, null); // maybe happens if .destroy called immediately after connect?
				self._respFunc = cb;
				self.socket = self.connectSocket(function(err) {
					if(!err) return;
					self._respFunc = null;
					self._clearTimer(); // clear connection timeout timer
					cb(err);
				});
				if(self.socket.setNoDelay) // tls.setNoDelay not documented, but seems to be available
					self.socket.setNoDelay(true);
				if(self.opts.tcpKeepAlive !== false && self.socket.setKeepAlive)
					self.socket.setKeepAlive(true, self.opts.tcpKeepAlive);
				if(self.opts.connect.path)
					self.debug('Connecting to unix' + (self.opts.secure ? '(s)':'') + ':' + self.opts.connect.path + '...');
				else
					self.debug('Connecting to nntp' + (self.opts.secure ? 's':'') + '://' + self.opts.connect.host + ':' + self.opts.connect.port + '...');
				
				self.socket.once('error', self._boundOnConnectFail);
				self.socket.once('end', self._boundOnConnectFail);
				self.socket.once('close', self._boundOnClose);
				self.socket.on('data', self._boundOnData);
			},
			function(code, info, cb) {
				self._respFunc = null;
				if(self._lastError) return;
				if(self._finished) return cb(null, null, null);
				
				self.debug('NNTP connection established');
				if(code == 201) {
					self.canPost = false;
					self.debug('NNTP server won\'t accept posts');
				} else {
					var err = checkExpect(200, 'connect', code, info);
					if(err) return cb(err);
					self.canPost = true;
				}
				if(self.opts.user) {
					self._setState('authenticating');
					self._respFunc = cb;
					self._request('AUTHINFO USER ' + self.opts.user + '\r\n', 'auth-user');
				} else cb(null, null, null);
			},
			function(code, info, cb) {
				if(self.opts.user && !self._finished) {
					if(self._lastError) return;
					
					var err = checkExpect(381, 'auth user', code, info);
					if(err) return cb(err);
					self._respFunc = cb;
					self._request('AUTHINFO PASS ' + self.opts.password + '\r\n', 'auth-pass');
				} else cb(null, null, null);
			},
			function(code, info, cb) {
				if(self.opts.user && !self._finished) {
					if(self._lastError) return;
					
					var err = checkExpect(281, 'auth pass', code, info);
					if(err) return cb(err);
					
					self.debug('NNTP connection authenticated');
					cb();
				} else cb();
			},
			function(cb) {
				// group previously selected - re-select it
				if(self.currentGroup && !self._finished) {
					if(self._lastError) return;
					
					self._respFunc = function(err, code, info) {
						if(!err && (code != 411 && code != 211))
							return cb(new NNTPError('bad_response', 'Unexpected response to GROUP (code: ' + code + '): ' + info));
						self._groupResponse(cb, err, code, info);
					};
					self._request('GROUP ' + self.currentGroup + '\r\n', 'group');
				} else cb();
			}
		], function(err) {
			if(err)
				return self._onConnectFail(err);
			if(self._finished)
				return self._onConnectFail(new NNTPError('cancelled', 'Connection cancelled'));
			if(self._lastError) return; // this is possible if an error occurs after all processing has succeeded, but an error pops up during the async nature of all this
			
			var cb = self._connectCb || self._defaultConnectCb;
			self._connectCb = null;
			self._respFunc = null;
			self._lastError = null;
			self._setState('connected');
			self.socket.removeListener('error', self._boundOnConnectFail);
			self.socket.removeListener('end', self._boundOnConnectFail);
			self.socket.once('error', self._boundOnError);
			self.socket.once('end', self._boundOnError);
			self.debug('NNTP connection ready');
			self._connectRetries = self.opts.connectRetries; // reset connect retry counter
			if(self._requests.length) {
				var reqs = self._requests;
				// rescheduled request
				self.debug('Retrying last request(s)');
				self._requests = [];
				reqs.forEach(function(req) {
					self[req.func](req);
				});
			}
			cb();
		});
	},
	// we'll probably want max reconnect tries + delays for _onError
	_onConnectFail: function(err) {
		if(this._lastError) return; // this case is possible if .destroy is called (below) in response to max retries being hit, and a response is being waited on
		this._lastError = err || true;
		var cb = this._connectCb;
		this._connectCb = null;
		if(this._finished) return (cb || this._defaultConnectCb)(err); // if already finished, this was called due to being destroyed
		this._errorStat(err ? err.code : 'connection_lost');
		this._clearTimer(); // clear connection timeout timer
		var errMsg = err ? err.message : 'connection lost';
		if(this._connectRetries-- == 0)
			this._finished = true;
		
		(function(next) {
			if((err && err.code == 'connect_timeout') || (this.socket && this.socket.readyState == 'closed')) {
				// don't try to perform a graceful close if the connection never succeeded, as it'd likely fail
				this._respFunc = null;
				this._destroy();
				next();
			} else
				this._close(next);
		}.bind(this))((this._finished ?
			function() {
				this._setState('inactive', 'connect fail');
				var e = new NNTPError('connect_fail', 'NNTP connection failed: ' + errMsg);
				if(cb) cb(e);
				this._runCloseCbs();
				if(this._requests.length) {
					this._requests.forEach(function(req) {
						req.err(e);
					});
					this._requests = [];
				}
				this._connectRetries = this.opts.connectRetries;
			}
		:
			function() {
				this._setState('waiting', 'connect fail');
				this.warn('NNTP connection failed: ' + errMsg + ', reconnecting after ' +(this.opts.reconnectDelay/1000)+ ' second(s)... (attempt ' + (this.opts.connectRetries - this._connectRetries) + '/' + this.opts.connectRetries + ')');
				
				this._connectCb = cb; // set this back for .destroy() calls to work properly (.connect() will reset this anyway)
				this._respFunc = cb;
				this._setTimer('reconnect', this.connect.bind(this, cb), this.opts.reconnectDelay);
			}
		).bind(this));
	},
	_onClose: function(had_error) {
		if(!this.socket) return; // node 10.x issue
		this._setState('disconnected', 'closed');
		this.dataQueue = [];
		this.dataLength = 0;
		this._isPosting = false;
		this.debug('NNTP connection closed');
		this.socket.removeAllListeners();
		this.socket = null;
	},
	_onError: function(err) {
		if(this._finished || this._lastError) return;
		this._lastError = err || true;
		
		var self = this;
		var reqsForEach = function(cb) {
			for(var i=0; i<self._requests.length; i++) {
				var req = self._requests[i];
				var postTimeoutHack = (self.opts.onPostTimeout && req.post && req.type == 'post-upload' && err && err.code == 'timeout' && req.cb);
				if(cb(req, i, postTimeoutHack))
					i--; // handle item removals
				
				break; // switch is here if we ever decide to go through all requests in the pipeline, instead of just the first
			}
		};
		var postTimeoutActions = Array(this._requests.length);
		if(this._requests.length) {
			reqsForEach(function(req, i, postTimeoutHack) {
				req.tries++;
				var postTimeoutAction;
				if(postTimeoutHack) {
					postTimeoutAction = self.opts.onPostTimeout[req.postTimeouts++];
					if(postTimeoutAction && postTimeoutAction.substring(0, 10) == 'strip-hdr=') {
						if(req.post.stripHeader(postTimeoutAction.substring(10))) {
							self.warn('NNTP response timed out during posting; removing article header "' + postTimeoutAction.substring(10) + '" and retrying...');
							postTimeoutAction = 'strip-hdr';
						} else
							postTimeoutAction = 'retry';
					}
					if(postTimeoutAction == 'ignore') {
						self.warn('NNTP response timed out during posting; assuming successful post');
					}
				}
				if((postTimeoutHack || req.tries <= self.opts.requestRetries) && (!postTimeoutHack || postTimeoutAction)) {
					if(err)
						self.warn('NNTP connection error occurred: ' + err.message + '; will retry ' + req.type + ' request (attempt ' + req.tries + '/' + self.opts.requestRetries + ')');
					else
						self.warn('NNTP connection unexpectedly lost, reconnecting and retrying ' + req.type + ' request... (attempt ' + req.tries + '/' + self.opts.requestRetries + ')');
				}
				postTimeoutActions[i] = postTimeoutAction;
			});
		} else {
			if(err)
				this.warn('NNTP connection error occurred: ' + err.message);
			else
				this.debug('NNTP connection lost');
		}
		
		this._errorStat(err && err.code ? err.code : 'connection_lost');
		this._close(function() {
			reqsForEach(function(req, i, postTimeoutHack) {
				var postTimeoutAction = postTimeoutActions[i];
				if(postTimeoutHack && postTimeoutAction == 'ignore') {
					// hack for dealing with servers that give post timeouts despite success
					self._takeRequest(i).cb(null, 240, '');
				} else if(postTimeoutHack && postTimeoutAction == 'strip-hdr') {
					// is a retry action, nothing needs to be done
				} else if((!postTimeoutHack && req.tries > self.opts.requestRetries) || (postTimeoutHack && !postTimeoutAction)) {
					// request attempt limit reached
					self._endRequest(req);
					self._takeRequest(i);
					postTimeoutActions.splice(i, 1);
					req.err(err || new NNTPError('connection_lost', 'Disconnected during request'));
					return true; // indicate that item was removed, to decrement loop counter
				}
			});
			
			if(self._requests.length || self.opts.keepAlive) {
				self._immediate = setImmediate(function() {
					self._immediate = null;
					if(!self._finished)
						self.connect();
				});
			} else {
				self._setState('inactive', 'no requests');
			}
		});
	},
	// function for node >= 12.10.0
	_onDataStatic: function(size, buf) {
		// use emit rather than direct call to allow unbinding of event (when connection closes) to work
		this.socket.emit('data', bufferSlice.call(buf, 0, size));
	},
	_onData: function(chunk) {
		// sanity check: we're not downloading anything or querying lists
		// even with a lot of pipelined requests, we shouldn't receive any excessively large chunks
		if(chunk.length > 256*1024) {
			this._triggerError('invalid_response', 'Received NNTP chunk size of ' + (Math.round(chunk.length/102.4)/10) + 'KB exceeds threshold of 256KB, connection will be reset');
			return;
		}
		
		this.bytesRecv += chunk.length;
		// grab incomming lines
		var data;
		if(this.opts.encoding)
			data = chunk.toString(this.opts.encoding);
		else
			data = chunk.toString();
		
		var p = data.indexOf('\r\n');
		if(p < 0) {
			p = false;
			// check annoying case of a \r and \n in separate chunks
			if(this.dataQueue.length && data[0] == '\n' && this.dataQueue[this.dataQueue.length-1].slice(-1) == '\r')
				p = -1;
		}
		
		if(p !== false) do {
			var line = this.dataQueue.join('') + data.substring(0, p+2);
			data = data.substring(p+2);
			this.dataQueue = [];
			this.dataLength = 0;
			
			var m = line.match(RE_LINE);
			if(m) {
				switch(m[1]) {
					// ignore '400 idle for too long' and '205 Connection closing' messages
					case '400':
						this.info('Server sent message "' + line.trim() + '"');
					case '205':
						continue;
					case '200':
					case '201':
						if(this.state != 'connecting') {
							// this seems to usually indicate a connection reset
							// we'll deal with this by tearing down our connection and starting fresh
							this._triggerError('unexpected_connect', 'Received unexpected connect message from server');
							return;
						}
				}
			}
			if(this._requests.length || this._respFunc) {
				/* the following doesn't work well if TLS is enabled
				if(this.socket.bufferSize)
					// TODO: may be a good idea to tear down the connection?
					this.warn('NNTP connection de-sync detected (received message whilst send data not sent)');
				*/
				
				this._clearTimer();
				var rf = this._respFunc;
				this._respFunc = null;
				var req;
				if(!rf) {
					req = this._requests[0];
					rf = req.cb;
					
					if(req.type == 'post-upload' && !req.articleSent) {
						this._triggerError('post_interrupted', 'Server sent "' + (code + ' ' + m[2].trim()) + '" response during upload');
						return;
					}
				}
				
				var err, nonFatalError = false;
				if(!m)
					err = new NNTPError('invalid_response', 'Unexpected line format: ' + line);
				else {
					var code = m[1]|0;
					if(req) {
						if(req.validResp && req.validResp.indexOf(code) == -1) {
							if(req.type == 'post' && FAILED_POST_CODES[this.postMethod].indexOf(code) > -1) {
								err = new NNTPError('post_denied', 'Server could not accept post (code: ' + code + '): ' + m[2].trim());
								nonFatalError = true;
							} else if(code >= 400 && code < 500) {
								err = new NNTPError('unknown_error', 'Server returned unexpected error to '+req.type+' (code: ' + code + '): ' + m[2].trim());
								nonFatalError = true;
							} else
								err = new NNTPError('bad_response', 'Unexpected response to '+req.type+' (code: ' + code + '): ' + m[2].trim());
						}
						if(this._onDrainListener && req.type == 'post-upload') {
							// got a response before the drain event fired; this could be a connection desync, but we'll assume the post arrived successfully, and our handler was just fired too late
							// req.articleSent is guaranteed to be true here, due to check above
							this.socket.emit('drain');
							this._clearTimer(); // clear response wait timer, since we have the response already
						}
					}
				}
				if(err) {
					if(req && (this.opts.retryBadResp || nonFatalError))
						this._onError(err);
					else {
						if(req) this._takeRequest();
						rf(err);
					}
				} else {
					if(req) this._takeRequest();
					rf(null, m[1]|0, m[2].trim());
				}
			} else if(m) {
				this.warn('Unexpected response received: ' + line.trim());
				this._errorStat('unexpected_response');
			} else {
				this.warn('Unexpected invalid data received: ' + line);
				this._errorStat('unexpected_data');
			}
		} while((p = data.indexOf('\r\n')) >= 0);
		if(data.length) {
			this.dataLength += data.length;
			// as we never request lists and the like, there should be no reason that server responses exceed 4K
			if(this.dataLength > 4096) {
				this._triggerError('invalid_response', 'Received NNTP message larger than 4KB, connection will be reset');
				return;
			}
			this.dataQueue.push(data);
		}
	},
	_runCloseCbs: function() {
		this._callMulti(this._onCloseCb);
		this._onCloseCb = [];
	},
	_addCloseCb: function(cb) {
		if(!cb) return;
		if(this.state == 'closing')
			this._onCloseCb.push(cb);
		else
			cb();
	},
	_resetState: function() { // called after the connection has finished
		this._connectRetries = this.opts.connectRetries;
		this.currentGroup = null;
	},
	_getNotifyCbs: function() {
		var cbs = this._requests.map(function(req) {
			return req.cb;
		}).filter(function(x) {return x;});
		if(this._respFunc)
			cbs.push(this._respFunc);
		this._requests = [];
		this._respFunc = null;
		return cbs;
	},
	_callMulti: function(cbs, err) {
		cbs.forEach(function(cb) {
			cb(err);
		});
	},
	// TODO: does this have issues with state, eg, if a request is still processing, will it overwrite the 'closing' state?
	end: function(cb) {
		if(this._finished) return this._addCloseCb(cb);
		this._finished = true;
		var state = this.state;
		var self = this;
		(function(cb) {
			if(!self.socket) return cb();
			self.socket.removeListener('end', self._boundOnConnectFail);
			// TODO: consider making this more like a regular QUIT request
			if((self._requests.length && self._requests[0].post && state == 'connected') || state == 'closing')
				// if posting/closing, can't pipeline on a QUIT message
				self._end(cb);
			else if(state == 'connecting') {
				self._destroy();
				cb();
			} else
				self._end(cb, CMD_QUIT);
		})(function() {
			self._setState('inactive', 'end');
			self._callMulti(self._getNotifyCbs(), new NNTPError('cancelled', 'Request cancelled (via \'end\')'));
			self._runCloseCbs();
			self._resetState();
			self._clearTimer();
			if(cb) cb();
		});
	},
	// like .end(), but cancells any request in progress
	close: function(cb) {
		if(this._finished) return this._addCloseCb(cb);
		this._finished = true;
		var cbs = this._getNotifyCbs();
		var self = this;
		(function(cb) {
			if(self.socket) {
				if(self.state == 'connecting') {
					self._destroy();
					cb();
				} else
					self._close(cb);
			} else
				cb();
		})(function() {
			self._setState('inactive', 'close');
			self._callMulti(cbs, new NNTPError('cancelled', 'Request cancelled (via \'close\')'));
			self._runCloseCbs();
			self._resetState();
			self._clearTimer();
			if(cb) cb();
		});
	},
	destroy: function() {
		if(this._finished) return;
		this._finished = true;
		var cbs = this._getNotifyCbs();
		this._clearTimer();
		if(this._throttleHandle)
			this._throttleHandle.cancel();
		this._destroy();
		this._setState('inactive', 'destroy');
		this._resetState();
		this._callMulti(cbs, new NNTPError('cancelled', 'Request cancelled (via \'destroy\')'));
	},
	_destroy: function() {
		if(this.socket) {
			this.socket.removeAllListeners();
			this.socket.destroy();
			this.socket = null;
		}
		this._setState('disconnected');
		this.dataQueue = [];
		this.dataLength = 0;
		this._isPosting = false;
	},
	_end: function(cb, msg) {
		this._closeWaitCb.push(cb);
		
		if(this.state != 'closing') {
			var self = this;
			var timer = null;
			if(this.opts.closeTimeout)
				timer = Timer('nntp-disconnect', function() {
					self.warn('Disconnect timed out, forcefully dropping connection...');
					self._destroy();
					self._callMulti(self._closeWaitCb);
					self._closeWaitCb = [];
				}, this.opts.closeTimeout);
			this.socket.once('close', function() {
				if(!self.socket) return; // node 10.x issue
				if(timer) timer.cancel();
				self._boundOnClose();
				self._callMulti(self._closeWaitCb);
				self._closeWaitCb = [];
			});
			this.socket.removeListener('close', this._boundOnClose); // need to manage the ordering of this one
			this.socket.once('error', function(err) {
				if(!self.socket) return; // node 10.x issue
				if(timer) timer.cancel();
				self._destroy();
				self._callMulti(self._closeWaitCb);
				self._closeWaitCb = [];
			});
			// prevent further writes if posting is in progress
			if(this._onDrainListener) {
				this.socket.removeListener('drain', this._onDrainListener);
				this._onDrainListener = null;
			}
			if(this._throttleHandle)
				this._throttleHandle.cancel();
			if(this._immediate) {
				clearImmediate(this._immediate);
				this._immediate = null;
			}
			this.debug('Closing connection...');
			if(msg !== undefined)
				this.socket.end(msg);
			else
				this.socket.end();
			this._setState('closing');
		} else if(msg !== undefined)
			this.warn('InternalError: attempting to send closing message after close');
	},
	_close: function(cb) {
		this._clearTimer();
		this._respFunc = null;
		
		if(this.opts.errorTeardown || !this.socket) {
			this._destroy();
			cb();
		} else {
			this.dataQueue = [];
			this.dataLength = 0;
			this._isPosting = false;
			// remove all listeners except 'close' (as well as internally added listeners for other events)
			this.socket.removeListener('end', this._boundOnConnectFail);
			this.socket.removeListener('end', this._boundOnError);
			this.socket.removeListener('error', this._boundOnConnectFail);
			this.socket.removeListener('error', this._boundOnError);
			this.socket.removeListener('data', this._boundOnData);
			if(this._onDrainListener) {
				this.socket.removeListener('drain', this._onDrainListener);
				this._onDrainListener = null;
			}
			this.socket.once('error', function(err) {
				this.warn('NNTP connection error occurred during close: ' + err.message);
			}.bind(this));
			this.socket.resume(); // shouldn't be necessary, but in case node decides to pause the stream due to it having no data listeners or something...
			this._end(cb);
		}
	},
	_triggerError: function(code, desc) {
		if(this._finished) {
			// should only be possible to reach here if .end was called with a pending request
			this._errorStat(code);
			this.warn('NNTP connection error occurred: ' + desc);
			if(this._requests.length) { // is it even possible for this to be false?
				var err = new NNTPError(code, desc);
				this._requests.forEach(function(req) {
					req.err(err);
				});
				this._requests = [];
			}
		} else {
			this[this.state == 'connected' ? '_onError':'_onConnectFail'](new NNTPError(code, desc));
		}
	},
	date: function(cb) {
		this._doRequest(CMD_DATE, 'date', [111], function(err, code, info) {
			if(err) return cb(err);
			var m = info.match(RE_DATE);
			var date;
			if(m) date = new Date(m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + m[6]);
			if(!date || isNaN(date)) return cb(new NNTPError('invalid_response', 'Invalid date returned: ' + info));
			cb(null, date);
		});
	},
	// group cannot contain newlines
	group: function(group, cb) {
		this._doRequest('GROUP ' + group + '\r\n', 'group', [411, 211], this._groupResponse.bind(this, cb));
	},
	_groupResponse: function(cb, err, code, info) {
		if(err) return cb(err);
		if(code == 411) return cb(new NNTPError('invalid_group', 'Selected group does not exist'));
		
		// format: 211 num_articles_estimate first_num last_num group_name
		var m = info.match(RE_GROUP);
		if(!m) return cb(new NNTPError('invalid_response', 'Unexpected response format to GROUP request: ' + info));
		this.currentGroup = m[4];
		cb(null);
	},
	// id cannot contain newlines
	stat: function(id, cb) {
		if(typeof id != 'number')
			id = '<' + id + '>'; // handle message ID
		var self = this;
		this._doRequest('STAT ' + id + '\r\n', 'stat', [423, 430, 223], function(err, code, info) {
			if(err) return cb(err);
			// TODO: error 412 no newsgroup has been selected
			if(code == 423 || code == 430) return cb(null, null); // no such article
			
			var m = info.match(RE_STAT);
			if(!m) {
				if(code == 223 && info.length == 0) {
					// have seen this sort of response on Usenet-Farm
					self.warn('Server responded with success to stat request, but did not return details. Assuming article is missing...');
					return cb(null, null);
				}
				cb(new NNTPError('invalid_response', 'Unexpected response for stat request: ' + info + ' (code: ' + code + ')'));
			}
			else cb(null, [m[1]|0, m[2]]);
		});
	},
	// post must be a Post object
	post: function(post, cb) {
		var req = new NNTPReq('__post', CMD_POST, 'post', [this.postMethod != 'POST' ? 335 : 340], cb);
		req.post = post;
		this.__post(req);
	},
	__post: function(req) {
		var post = req.post, cb = req.cbParent;
		if(!this.canPost) return cb(new NNTPError('posting_denied', 'Server has indicated that posting is not allowed'));
		var self = this;
		(function doPost() {
			req.func = '__doRequest';
			req.errVal = null;
			req.type = 'post';
			req.validResp = [self.postMethod != 'POST' ? 335 : 340];
			
			// we hard-code a message-id, since it's best to make it unique for retries
			if(!post.keepMessageId) post.randomizeMessageID();
			if(self.postMethod == 'IHAVE')
				req.msg = 'IHAVE <' + post.messageId + '>\r\n';
			if(self.postMethod == 'XREPLIC')
				req.msg = 'XREPLIC ' + (post.getHeader('Newsgroups')||'').replace(/,.*$/,'').trim() + ':' + ((Math.random()*0x7fffffff)|0) + '\r\n';
			
			
			req.cbParent = function(err, code, info) {
				if(err) {
					// TODO: is it reliable to keep the connection as is, or should it be pulled down?
					self._isPosting = false;
					return cb(err);
				}
				
				var msgId = post.messageId;
				
				// mark this request to be retried if disconnected
				req.func = '__post';
				req.cbParent = cb;
				req.errVal = msgId;
				req.type = 'post-upload';
				req.validResp = self._postValidResp;
				req.cb = function(err, code, info) {
					self._endRequest(req);
					self._isPosting = false;
					if(err) return cb(err, msgId);
					
					//if(self.socket && self._onDrainListener) self.socket.removeListener('drain', self._onDrainListener);
					if(FAILED_POST_CODES[self.postMethod].indexOf(code) > -1) {
						if(req.postRetries++ < self.opts.postRetries) {
							self.warn('Got "' + (code + ' ' + info).trim() + '" response when posting article ' + msgId + '; will retry (attempt ' + req.postRetries + '/' + self.opts.postRetries + ')');
							self._errorStat('post_denied');
							return self._setTimer('repost', doPost, self.opts.postRetryDelay);
						}
						return cb(new NNTPError('post_denied', 'Server could not accept post '+ msgId + ', returned: ' + code + ' ' + info), msgId);
					}
					
					// if server provides a message-id, return to calling function, otherwise don't mention a thing
					var m = info.match(RE_POST);
					if(m) {
						if(msgId && msgId != m[1]) {
							if(!self._warnedIdDiff) {
								self.warn('Server returned a different Message-ID (' + m[1] + ') to the one we sent it (' + msgId + '); replacing our ID with received ID. This warning won\'t be shown again for this connection');
								self._warnedIdDiff = true;
							}
							post.messageId = m[1];
						}
						msgId = m[1];
					}
					self.debug('Posted article ' + msgId);
					cb(null, msgId);
				};
				if(self.postMethod == 'TAKETHIS')
					req.size = self._uploadPost(post.data, req, 'TAKETHIS <' + post.messageId + '>\r\n');
				else
					req.size = self._uploadPost(post.data, req);
			};
			if(self.postMethod == 'TAKETHIS') // bypass first request; TODO: think of a more elegant solution
				req.cbParent(null);
			else
				self.__doRequest(req);
		})();
	},
	_doRequest: function(msg, type, validResp, cb) {
		this.__doRequest(new NNTPReq('__doRequest', msg, type, validResp, cb));
	},
	__doRequest: function(req) {
		if(this._isPosting) // TODO: support pipelining TAKETHIS (need to deal with how _uploadPost works)
			throw new Error('Cannot make request whilst posting');
		if(this._finished)
			return req.cbParent(new NNTPError('connection_ended', 'Cannot make request after end'));
		else if(req.post)
			this._isPosting = true;
		
		if(this.state == 'inactive') {
			this.connect();
		}
		this._startRequest(req);
		if(this.state == 'connected') {
			this._reqStat(req.type);
			req.cb = function() {
				this._endRequest(req);
				req.cbParent.apply(null, arguments);
			}.bind(this);
			req.size = this._request(req.msg, req.type);
		}
		// otherwise, request is scheduled on connect
	},
	_request: function(msg, type) {
		if(this.state == 'inactive')
			throw new NNTPError('not_connected', 'Not connected to an NNTP server');
		// TODO: debug output
		if(!this._timer) this._requestSetTimer(type, this.opts.timeout);
		return this._write(msg, true);
	},
	_uploadPost: function(msg, req, prefix) {
		if(this.state == 'inactive')
			throw new NNTPError('not_connected', 'Not connected to an NNTP server');
		if(this._timer)
			throw new Error('Timer already set when trying to upload post');
		var self = this;
		
		this._startRequest(req);
		
		var retLen = msg.length;
		if(prefix) {
			this._write(prefix);
			retLen += prefix.length;
		}
		if(this.opts.uploadChunkSize && this.opts.uploadChunkSize < msg.length) {
			var pos = 0;
			var _doWrite = function() {
				var len = Math.min(msg.length - pos, self.opts.uploadChunkSize);
				var oldPos = pos;
				pos += len;
				self._writePostWait(bufferSlice.call(msg, oldPos, pos), pos >= msg.length, req, function(cancelled) {
					if(cancelled) return;
					self.reqBytesSent += len;
					if(pos >= msg.length) {
						self._requestSetTimer('post-data', self.opts.timeout);
					} else {
						self._immediate = setImmediate(function() { // workaround for bug in node 0.10.x causing excessive process.nextTick calls; bug not present in node 4.7.x
							self._immediate = null;
							// need to recheck state to ensure we aren't closing, before trying to write (onDrain event is always removed before .end() is called, but it's possible this setImmediate was already scheduled)
							if(self.state == 'connected')
								_doWrite();
						});
					}
				});
			};
			_doWrite();
			
			return retLen - msg.length; // hack to disable network speed update on request completion
		} else {
			this._writePostWait(msg, true, req, function(cancelled) {
				if(cancelled) return;
				self._requestSetTimer('post-data', self.opts.timeout);
			});
			return retLen;
		}
	},
	_writePostWait: function(msg, lastChunk, req, cb) {
		var self = this;
		this._throttleHandle = this.throttle(msg.length, function(cancelled) {
			self._throttleHandle = null;
			if(cancelled) return cb(cancelled);
			if(lastChunk) req.articleSent = true;
			self._requestSetTimer('post-upload', self.opts.postTimeout);
			if(self._write(msg)) {
				self._clearTimer();
				cb();
			} else {
				self.socket.once('drain', self._onDrainListener = function() {
					self._onDrainListener = null;
					self._clearTimer();
					cb();
				});
			}
		});
	},
	_requestSetTimer: function(type, time) {
		if(!time) return;
		var self = this;
		this._setTimer(type, function() {
			// timed out - retry
			// we destroy the connection because this one probably isn't reliable
			// since NNTP doesn't have request/response identifiers, this is the safest approach
			self._triggerError('timeout', 'Response timed out (' + type + ')');
		}, Math.max(0, time));
	},
	_takeRequest: function(idx) {
		if(idx)
			return this._requests.splice(idx, 1)[0];
		
		var req = this._requests.shift();
		if(this._requests.length && this.opts.timeout) {
			var nr = this._requests[0];
			this._requestSetTimer(nr.type, nr.ts + this.opts.timeout - Date.now());
		}
		if(!this._requests.length && this.state == 'connected') {
			this.lastIdleStart = Date.now();
		}
		return req;
	},
	_write: function(data, rtnLen) {
		if(this.state == 'closing') {
			var sData = data.toString();
			if(sData.length < 100)
				this.warn('InternalError: attempting to write "' + sData + '" after close');
			else
				this.warn('InternalError: attempting to write after close');
		}
		var len, writ;
		if(typeof data == 'string') {
			this.bytesSent += (len = Buffer.byteLength(data, this.opts.encoding));
			writ = this.socket.write(data, this.opts.encoding);
		} else {
			this.bytesSent += (len = data.length);
			writ = this.socket.write(data);
		}
		return rtnLen ? len : writ;
	},
	_setTimer: function(label, func, time) {
		if(this._timer) throw new Error('Timer already set: trying to set for ' + label + ', but already set for ' + this._timer.label.substring(5));
		this._timer = Timer('nntp-'+label, function() {
			this._timer = null;
			func();
		}, time);
	},
	_clearTimer: function() {
		if(this._timer) {
			this._timer.cancel();
			this._timer = null;
		}
	},
	warn: function(msg) {
		if(NNTP.log) NNTP.log.warn(msg);
	},
	info: function(msg) {
		if(NNTP.log) NNTP.log.info(msg);
	},
	debug: function(msg) {
		if(NNTP.log) NNTP.log.debug(msg);
	},
	
	getCurrentActivity: function() {
		if(this.state != 'connected') {
			if(this.stateCause)
				return this.state + ' [' + this.stateCause + ']';
			return this.state;
		}
		if(!this._requests.length)
			return 'idle';
		if(this._requests[0].type == 'post-upload')
			return 'posting';
		return 'requesting (' + this._requests[0].type + ')';
	},
	_setState: function(state, cause) {
		this.lastActivity = Date.now();
		if(state == 'connected') {
			this.lastConnectedStart = this.lastActivity;
			if(!this._requests.length)
				this.lastIdleStart = this.lastActivity;
		}
		else if(this.state == 'connected') {
			if(this.lastConnectedStart) // should always be set
				this.connectedTime += this.lastActivity - this.lastConnectedStart;
			this.lastConnectedStart = null;
			if(this.lastIdleStart) {
				this.idleTime += this.lastActivity - this.lastIdleStart;
				this.lastIdleStart = null;
			}
		}
		this.state = state;
		this.stateCause = cause;
	},
	_startRequest: function(req) {
		this._requests.push(req);
		this.lastActivity = (req.ts = Date.now());
		if(this.rawSpeedTracker) this.rawSpeedTracker.start(req.ts);
		if(this.lastIdleStart) {
			this.idleTime += this.lastActivity - this.lastIdleStart;
			this.lastIdleStart = null;
		}
	},
	_endRequest: function(req) {
		this.lastActivity = Date.now();
		if(this.state == 'connected') {
			// note: for cases when server is unresponsive, the slowdown there isn't considered
			this.reqBytesSent += req.size;
			if(this.rawSpeedTracker) this.rawSpeedTracker.end(this.lastActivity);
		}
	},
	_errorStat: function(type) {
		this.numErrors[type] = 1 + (this.numErrors[type] || 0);
	},
	_reqStat: function(type) {
		this.numRequests[type] = 1 + (this.numRequests[type] || 0);
	},
	numErrorsDetail: function() {
		var ret = [];
		for(var k in this.numErrors) {
			ret.push(k + ' (' + this.numErrors[k] + ')');
		}
		if(ret.length) return ret.join(', ');
		return '-';
	},
	numRequestsDetail: function() {
		var active = {};
		this._requests.forEach(function(req) {
			var type = req.type;
			if(type == 'post-upload') type = 'post';
			active[type] = 1 + (active[type] || 0);
		});
		
		// check for mis-labelled stuff?
		for(var k in active) {
			if(!(k in this.numRequests))
				this.numRequests[k] = 0;
		}
		
		var ret = [];
		for(var k in this.numRequests) {
			var count = '' + this.numRequests[k];
			if(active[k]) {
				if(active[k] > 3)
					count += ' [*' + active[k] + ']';
				else {
					count += '**********'.substring(0, active[k]);
				}
			}
			ret.push(k + ' (' + count + ')');
		}
		if(ret.length) return ret.join(', ');
		return '-';
	},
	timeStats: function(now) {
		var stats = {connected: this.connectedTime, idle: this.idleTime};
		if(!now) now = Date.now();
		if(this.state == 'connected') {
			if(this.lastConnectedStart) // should always be set
				stats.connected += now - this.lastConnectedStart;
			if(this.lastIdleStart && !this._requests.length)
				stats.idle += now - this.lastIdleStart;
		}
		return stats;
	}
};

module.exports = NNTP;
//NNTP.log = {info: console.info.bind(console), warn: console.warn.bind(console), debug: console.log.bind(console)};
NNTP.log = null;
