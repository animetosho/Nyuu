#!/usr/bin/env node

"use strict";
process.title = 'Nyuu';

var fs = require('fs');
var util = require('../lib/util');
var error = function(msg) {
	console.error(msg);
	console.error('Enter `nyuu --help` or `nyuu --help-full` for usage information');
	process.exit(1);
};
var processes;
var processStart = function(purpose) {
	if(!processes) processes = new (require('../cli/procman'))();
	var proc = processes.start.apply(processes, Array.prototype.slice.call(arguments, 1));
	proc.once('exit', function(code) {
		if(logger && code) logger.warn(purpose + ' process exited with code ' + code);
	});
	proc.once('error', function(err) { // error usually doesn't occur, because command is executed via shell, so it should always spawn
		if(logger) logger.warn(purpose + ' process issued error: ' + err.toString());
	});
	return proc;
};


var arg_parser = require('../cli/arg_parser');
var cliUtil = require('../cli/util');


var servOptMap = {
	host: {
		type: 'string',
		alias: 'h'
	},
	port: {
		type: 'int',
		alias: 'P',
		keyMap: 'connect/port'
	},
	'bind-host': {
		type: 'string',
		keyMap: 'connect/localAddress',
		ifSetDefault: ''
	},
	'tcp-keep-alive': {
		type: 'time',
		keyMap: 'tcpKeepAlive',
		ifSetDefault: '30s'
	},
	ipv6: {
		type: 'bool',
		keyMap: 'connect/family',
		fn: function(v) {
			return v ? 6 : undefined;
		},
		alias: '6'
	},
	ssl: {
		type: 'bool',
		keyMap: 'secure',
		alias: 'S'
	},
	'ignore-cert': {
		type: 'bool',
		keyMap: 'connect/rejectUnauthorized',
		fn: function(v) {
			return !v;
		}
	},
	'sni-host': {
		type: 'string',
		keyMap: 'connect/servername',
		ifSetDefault: ''
	},
	'ssl-ciphers': {
		type: 'string',
		keyMap: 'connect/ciphers',
		ifSetDefault: ''
	},
	'ssl-method': {
		type: 'string',
		keyMap: 'connect/secureProtocol',
		ifSetDefault: ''
	},
	'ssl-ca': {
		type: 'array',
		keyMap: 'connect/ca',
		fn: function(v) {
			return v.map(function(file) {
				return fs.readFileSync(file);
			});
		}
	},
	user: {
		type: 'string',
		alias: 'u',
		keyMap: 'user',
		ifSetDefault: ''
	},
	password: {
		type: 'string',
		alias: 'p',
		keyMap: 'password',
		ifSetDefault: ''
	},
	timeout: {
		type: 'time',
		keyMap: 'timeout'
	},
	'connect-timeout': {
		type: 'time',
		keyMap: 'connTimeout'
	},
	'post-timeout': {
		type: 'time',
		keyMap: 'postTimeout'
	},
	'reconnect-delay': {
		type: 'time',
		keyMap: 'reconnectDelay'
	},
	'connect-retries': {
		type: 'int',
		keyMap: 'connectRetries'
	},
	'request-retries': {
		type: 'int',
		keyMap: 'requestRetries'
	},
	'retry-on-bad-resp': {
		type: 'bool',
		keyMap: 'retryBadResp'
	},
	'post-retries': {
		type: 'int',
		postOnly: true,
		keyMap: 'postRetries'
	},
	'post-retry-delay': {
		type: 'time',
		postOnly: true,
		keyMap: 'postRetryDelay'
	},
	'post-fail-reconnect': {
		type: 'bool',
		postOnly: true,
		keyMap: 'postFailReconnect'
	},
	'error-teardown': {
		type: 'bool',
		keyMap: 'errorTeardown'
	},
	'disconnect-timeout': {
		type: 'time',
		keyMap: 'closeTimeout'
	},
	'on-post-timeout': {
		type: 'list',
		postOnly: true,
		keyMap: 'onPostTimeout',
		fn: function(v) {
			if(!v) return;
			return v.map(function(s) {
				if(s != 'retry' && s != 'ignore' && !s.match(/^strip-hdr=./))
					error('Unknown value for `on-post-timeout`: ' + s);
				return s;
			});
		}
	},
	'keep-alive': {
		type: 'bool',
		keyMap: 'keepAlive'
	},
	'post-chunk-size': {
		type: 'size0',
		postOnly: true,
		keyMap: 'uploadChunkSize'
	},
	'post-method': {
		type: 'enum',
		postOnly: true,
		enum: ['post','ihave','xreplic','takethis'],
		keyMap: 'postMethod'
	},
	'use-ihave': { // for backwards-compatibility
		type: 'bool',
		postOnly: true,
		keyMap: 'postMethod',
		fn: function(v) {
			return v ? 'ihave' : 'post';
		}
	},
	connections: {
		type: 'int',
		alias: 'n',
		checkAlias: 'k'
	},
	'max-upload-rate': {
		type: 'string',
		keyMap: 'throttleRate',
		postOnly: true,
		fn: function(v) {
			if(!v || v == '0') return null;
			var m = (''+v).match(/^([0-9.]*)([bkmgtpe])\/([0-9.]*)(m?s|[mhdw])$/i);
			if(!m) error('Invalid format for `--max-upload-rate`: ' + v);
			if(m[1] === '') m[1] = '1';
			if(m[3] === '') m[3] = '1';
			return {
				size: arg_parser.parseSize(m[1] + m[2]),
				time: arg_parser.parseTime(m[3] + m[4])
			};
		}
	},
};

// NOTE: for `{comment/2}` to work, this must be defined after the comment/2 options!
var _mainTransform = function(rx, v) {
	if(!v) return;
	var re_group_fname = /(\.[a-z0-9]{1,10}){0,2}(\.vol\d+[\-+]\d+\.par2)?(\.\d+|\.part\d+)?$/i;
	return function(filenum, filenumtotal, filename, filesize, part, parts, extra) {
		return v.replace(rx, function(m, token, a1) {
			switch(token.toLowerCase()) {
				case 'filenum': return filenum;
				case '0filenum': return cliUtil.lpad(''+filenum, (''+filenumtotal).length, '0');
				case 'files': return filenumtotal;
				case 'filename': return filename;
				case 'fnamebase': return filename.replace(re_group_fname, '');
				case 'filesize': return filesize;
				case 'fileksize': return Math.round(filesize / 10.24) / 100;
				case 'filemsize': return Math.round(filesize / 10485.76) / 100;
				case 'filegsize': return Math.round(filesize / 10737418.24) / 100;
				case 'filetsize': return Math.round(filesize / 10995116277.76) / 100;
				case 'fileasize': return cliUtil.friendlySize(filesize);
				case 'part': return part;
				case '0part': return cliUtil.lpad(''+part, (''+parts).length, '0');
				case 'parts': return parts;
				// ugly hack which relies on placement of the options
				case 'comment': return argv.comment || '';
				case 'comment2': return argv.comment2 || '';
				case 'size': return extra.rawSize;
				case 'timestamp': return extra.genTime;
				case 'value': return extra;
				default:
					// rand(n)
					var rnd = '';
					var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
					while(a1--)
						rnd += chars[(Math.random() * chars.length) | 0];
					return rnd;
			}
		});
	};
};
var articleHeaderFn = _mainTransform.bind(null, /\$?\{(0?filenum|files|filename|fnamebase|filesize|file[kmgta]size|0?part|parts|size|comment2?|timestamp|rand\((\d+)\))\}/ig);
var nzbHeaderFn = _mainTransform.bind(null, /\$?\{(0?filenum|files|filename|fnamebase|filesize|file[kmgta]size|0?part|parts|value)\}/ig);
var RE_FILE_TRANSFORM = /\$?\{(0?filenum|files|filename|fnamebase|filesize|file[kmgta]size|0?part|parts)\}/ig;
var fileTransformFn = _mainTransform.bind(null, RE_FILE_TRANSFORM);
var filenameTransformFn = function(v) {
	if(!v) return;
	var path = require('path');
	return function(filename) {
		return v.replace(/\$?\{(filename|basename|pathname)\}/ig, function(m, token, a1) {
			switch(token.toLowerCase()) {
				case 'basename':
					return path.basename(filename);
				case 'pathname':
					return path.dirname(filename);
				case 'filename':
					return filename;
			}
		});
	};
};
var optMap = {
	/*'check-reuse-conn': {
		type: 'bool',
		map: 'check/ulConnReuse'
	},*/
	'check-delay': {
		type: 'time',
		map: 'check/delay'
	},
	'check-retry-delay': {
		type: 'time',
		map: 'check/recheckDelay'
	},
	'check-tries': {
		type: 'int',
		map: 'check/tries'
	},
	'check-group': {
		type: 'string',
		map: 'check/group',
		ifSetDefault: ''
	},
	'check-post-tries': {
		type: 'int',
		map: 'check/postRetries'
	},
	'article-size': {
		type: 'size',
		alias: 'a',
		map: 'articleSize'
	},
	'article-line-size': {
		type: 'int',
		map: 'bytesPerLine',
		fn: function(v) {
			if(v < 1) error('Invalid value for `article-line-size`');
			return v;
		}
	},
	'article-encoding': {
		type: 'enum',
		enum: ['ascii','latin1','utf8'],
		map: 'articleEncoding',
		default: 'utf8'
	},
	comment: {
		type: 'string',
		alias: 't',
		map: 'comment',
		ifSetDefault: ''
	},
	comment2: {
		type: 'string',
		map: 'comment2',
		ifSetDefault: ''
	},
	date: {
		type: 'string',
		map: 'postDate',
		ifSetDefault: '',
		fn: function(v) {
			if((typeof v == 'string') && v.toLowerCase() == 'now')
				return Date.now();
			return v;
		}
	},
	'keep-message-id': {
		type: 'bool',
		map: 'keepMessageId'
	},
	'group-files': {
		type: 'bool',
		alias: 'F',
		map: 'groupFiles'
	},
	header: {
		type: 'map',
		alias: 'H'
	},
	subject: {
		type: 'string',
		alias: 's',
		map: 'postHeaders/Subject',
		fn: articleHeaderFn
	},
	filename: {
		type: 'string',
		map: 'fileNameTransform',
		fn: filenameTransformFn
	},
	from: {
		type: 'string',
		alias: 'f',
		map: 'postHeaders/From',
		fn: articleHeaderFn
	},
	groups: {
		type: 'string',
		alias: 'g',
		map: 'postHeaders/Newsgroups'
	},
	'message-id': {
		type: 'string',
		map: 'postHeaders/Message-ID',
		fn: articleHeaderFn
	},
	out: {
		type: 'string',
		alias: 'o',
		map: 'nzb/writeTo'
	},
	minify: {
		type: 'bool',
		map: 'nzb/minify'
	},
	'nzb-compress': {
		type: 'string',
		map: 'nzb/compression',
		ifSetDefault: 'gzip',
		fn: function(v) {
			if(v && ['gzip','zlib','deflate','brotli'].indexOf(v) < 0)
				error('Invalid value supplied for `nzb-compress`: ' + v + '. Valid values: gzip, zlib, deflate, brotli');
			return v;
		}
	},
	'nzb-compress-level': {
		type: 'int',
		map: 'nzb/compressOpts/level'
	},
	'nzb-encoding': {
		type: 'string',
		map: 'nzb/writeOpts/encoding',
		fn: function(v) {
			try {
				Buffer.alloc ? Buffer.from('', v) : new Buffer('', v);
			} catch(x) {
				error('Unknown encoding for `nzb-encoding`: ' + v + '. Valid encodings include: ascii, utf8, utf16le, latin1, base64, hex');
			}
			return v;
		}
	},
	'nzb-subject': {
		type: 'string',
		map: 'nzb/overrides/subject',
		fn: nzbHeaderFn
	},
	'nzb-poster': {
		type: 'string',
		map: 'nzb/overrides/poster',
		fn: nzbHeaderFn
	},
	overwrite: {
		type: 'bool',
		alias: 'O',
		map: 'nzb/writeOpts/flags',
		fn: function(v) {
			return v ? 'w' : 'wx';
		}
	},
	meta: {
		type: 'map',
		alias: 'M'
	},
	// "standard" NZB meta fields from https://sabnzbd.org/wiki/extra/nzb-spec#toc2
	'nzb-title': {
		type: 'string',
		map: 'nzb/metaData/title'
	},
	'nzb-tag': {
		type: 'array',
		map: 'nzb/metaData/tag'
	},
	'nzb-category': {
		type: 'array',
		map: 'nzb/metaData/category'
	},
	'nzb-password': {
		type: 'array',
		map: 'nzb/metaData/password'
	},
	'nzb-cork': {
		type: 'bool',
		map: 'nzb/corkOutput'
	},
	subdirs: {
		type: 'string',
		alias: 'r',
		map: 'subdirs',
		ifSetDefault: 'keep',
		fn: function(v) {
			if(!v) return 'include';
			if(['skip','keep','include'].indexOf(v) < 0)
				error('Invalid option supplied for `subdirs`: ' + v + '. Valid values: skip, keep, include');
			return v;
		}
	},
	'skip-symlinks': {
		type: 'bool',
		alias: 'L',
		map: 'skipSymlinks'
	},
	'input-file': {
		type: 'array',
		alias: 'i'
	},
	'input-file0': {
		type: 'array',
		alias: '0'
	},
	'input-file-enc': {
		type: 'string',
		default: 'utf8'
	},
	'disk-req-size': {
		type: 'size',
		map: 'diskReqSize'
	},
	'disk-buf-size': {
		type: 'int',
		map: 'diskBufferSize'
	},
	'post-queue-size': {
		type: 'int',
		map: 'articleQueueBuffer'
	},
	'check-queue-size': {
		type: 'int',
		map: 'check/queueBuffer'
	},
	'check-queue-cache': {
		type: 'int',
		map: 'check/queueCache'
	},
	'use-post-pool': {
		type: 'bool',
		map: 'useBufferPool'
	},
	'connection-threads': {
		type: 'int',
		map: 'connectionThreads'
	},
	'preload-modules': {
		type: 'bool'
	},
	'use-lazy-connect': {
		type: 'bool',
		map: 'useLazyConnect'
	},
	'skip-errors': {
		type: 'list',
		alias: 'e',
		map: 'skipErrors',
		ifSetDefault: true,
		fn: function(v) {
			if(!v) return false;
			if(v.indexOf('all') >= 0)
				return true;
			return v;
		}
	},
	'post-error-limit': {
		type: 'int',
		map: 'maxPostErrors'
	},
	'dump-failed-posts': {
		type: 'string',
		map: 'dumpPostLoc',
		ifSetDefault: ''
	},
	'input-raw-posts': {
		type: 'bool'
	},
	'delete-raw-posts': {
		type: 'bool',
		map: 'deleteRawPosts'
	},
	'copy-input': {
		type: 'string'
	},
	'copy-include': {
		type: 'string'
	},
	'copy-exclude': {
		type: 'string'
	},
	'copy-queue-size': {
		type: 'int',
		map: 'copyQueueBuffer'
	},
	
	help: {
		type: 'bool',
		alias: '?'
	},
	'help-full': {
		type: 'bool'
	},
	version: {
		type: 'bool'
	},
	'package-info': {
		type: 'bool'
	},
	'log-level': {
		type: 'int',
		alias: 'l'
	},
	'log-time': {
		type: 'bool',
		alias: 'T'
	},
	verbose: {
		type: 'bool',
		alias: 'v'
	},
	quiet: {
		type: 'bool',
		alias: 'q'
	},
	colorize: {
		type: 'bool',
		default: process.stderr.isTTY // assume colours are supported if TTY
	},
	progress: {
		type: 'array'
	},
	config: {
		type: 'string',
		alias: 'C'
	}
};

for(var k in servOptMap) {
	var o = servOptMap[k];
	optMap[k] = o;
	if(!o.postOnly) {
		var o2 = util.extend({}, o);
		delete o2.alias;
		if(o2.checkAlias) o2.alias = o2.checkAlias;
		optMap['check-' + k] = o2;
	}
}


var argv;
try {
	argv = arg_parser(process.argv.slice(2), optMap);
} catch(x) {
	error(x.message);
}
var isNode010 = process.version.match(/^v0\.10\./);


if(argv['help-full'] || argv.help) {
	var helpText;
	try {
		// for embedding help text
		helpText = require('./help.json')[argv['help-full'] ? 'full':'short'];
	} catch(x) {
		// use eval to prevent nexe trying to detect the variable
		helpText = fs.readFileSync(eval('__'+'dirname') + '/../help' + (argv['help-full'] ? '-full':'') + '.txt').toString();
	}
	console.error(helpText.replace(/^Nyuu(\r?\n)/, 'Nyuu v' + require('../package.json').version + '$1'));
	process.exit(0);
}
if(argv.version) {
	console.error(require('../package.json').version);
	process.exit(0);
}
if(argv['package-info']) {
	var pc = require('../package.json');
	var parsePackage = function(p) {
		var r = {};
		['version','description','license','author','homepage'].forEach(function(e) {
			if(e in p) r[e] = p[e];
		});
		return r;
	};
	
	// can't search package.json for dependencies (pc.dependencies) and use a loop, because nexe won't include it; TODO: fix this
	var modules = {
		nyuu: parsePackage(pc),
		async: parsePackage(require('../node_modules/async/package.json')),
		yencode: parsePackage(require('../node_modules/yencode/package.json')),
	};
	try {
		modules.nexe = parsePackage(require('../nexe/node_modules/nexe/package.json'));
	} catch(x) {}
	var m = {
		'Packages': modules,
		'Node Component Versions': process.versions,
		'Architecture': {arch: process.arch, platform: process.platform},
		//'Node Release': process.release,
		//'Node Features': process.features,
		'Node Compilation Config': process.config
	};
	
	for(var i in m) {
		console.error('\n' + i + ':');
		process.stderr.write(require('util').inspect(m[i], {colors: argv.colorize}) + '\n');
	}
	process.exit(0);
}


var evalConfig = function(data, filename) {
	var sandbox = util.extend({}, global);
	sandbox.module = {
		id: filename,
		exports: {},
		parent: module,
		filename: filename,
		children: [],
		paths: module.paths
	};
	sandbox.exports = sandbox.module.exports;
	sandbox.require = require;
	sandbox.global = sandbox;
	
	// add some handy shortcuts (like REPL)
	require('repl')._builtinLibs.forEach(function(m) {
		Object.defineProperty(sandbox, m, {
			get: function() {
				return sandbox[m] = require(m);
			},
			set: function(val) {
				delete sandbox[m];
				sandbox[m] = val;
			},
			configurable: true
		});
	});
	sandbox.__nyuu_pkg = require('../package.json'); // kinda necessary in nexe builds, since package.json doesn't exist there
	
	require('vm').runInNewContext(data, sandbox, isNode010 ? filename : {filename: filename});
	return sandbox.module.exports;
};

var ulOpts = require('../config.js');
if(argv.config || process.env.NYUU_CONFIG) {
	// TODO: allow proc:// or json:// ?
	var confFile = argv.config || process.env.NYUU_CONFIG;
	var confData = fs.readFileSync(confFile).toString();
	
	// try to determine type of config file from heuristics
	var confType;
	if(confFile.match(/\.json$/i))
		confType = 'json';
	else if(confFile.match(/\.js$/i))
		confType = 'js';
	else if(confData.trim().substr(0, 1) == '{')
		confType = 'json';
	else if(confData.match(/(^|[^a-zA-Z0-9])exports[^a-zA-Z0-9]/))
		confType = 'js';
	
	var cOpts;
	if(confType == 'json')
		cOpts = JSON.parse(confData);
	else if(confType == 'js')
		cOpts = evalConfig(confData, confFile);
	else
		error('Invalid config data supplied');
	
	if(cOpts.isFullConfig && confType == 'js') {
		if(cOpts.servers) {
			// for the default setup of one upload server, but multiple specified in custom config, duplicate the default setup for each custom server
			if(ulOpts.servers.length == 1 && cOpts.servers.length > 1) {
				var srv = JSON.stringify(ulOpts.servers[0]);
				for(var i = 1; i < cOpts.servers.length; i++)
					ulOpts.servers[i] = JSON.parse(srv);
			}
			if(ulOpts.servers.length == cOpts.servers.length) {
				// merge server options one by one
				ulOpts.servers.forEach(function(server, i) {
					util.deepMerge(server, cOpts.servers[i]);
				});
				delete cOpts.servers; // don't merge this any more
			}
		}
		util.deepMerge(ulOpts, cOpts);
	} else {
		// simple config format, just set unset CLI args
		cOpts = arg_parser(cOpts, optMap);
		
		// allow --quiet or --verbose to override whatever is specified in the config, without error
		if(argv.quiet || argv.verbose) {
			delete cOpts.quiet;
			delete cOpts.verbose;
		}
		for(var k in cOpts) {
			if(!(k in argv) && k[0] != ' ')
				argv[k] = cOpts[k];
		}
	}
}

var setPathedVal = function(base, key, val) {
	var path = key.split('/');
	var obj = base;
	for(var i=0; i<path.length-1; i++) {
		if(!(path[i] in obj))
			obj[path[i]] = {};
		obj = obj[path[i]];
	}
	obj[path.slice(-1)[0]] = val;
};

for(var k in argv) {
	var o = optMap[k];
	if(o && o.map)
		setPathedVal(ulOpts, o.map, argv[k]);
}


// handle server options mess
if(!ulOpts.servers || ulOpts.servers.length < 1)
	ulOpts.servers = [{}];

// check if postConnections/checkConnections is set in the config, if so, we assume that those servers are marked for posting/checking, otherwise, assume that all servers are fair game
var defNumConnPost = 0, defNumConnCheck = 0;
ulOpts.servers.forEach(function(server) {
	defNumConnPost += server.postConnections;
	defNumConnCheck += server.checkConnections;
	if(server.ulConnReuse)
		defNumConnCheck += server.postConnections;
});

var servOptHelper = function(k, val, type, servers) {
	if(val === null || val === undefined) return;
	
	var o = servOptMap[k];
	var key = o.keyMap;
	if(!key) switch(k) {
		case 'connections':
			key = type + 'Connections';
		break;
		case 'host':
			if(val.match(/^unix:/i)) {
				key = 'connect/path';
				val  = val.substr(5);
			} else
				key = 'connect/host';
		break;
		default:
			throw new Error('Unhandled server setting `' + k + '`');
	}
	
	servers.forEach(function(server) {
		setPathedVal(server, key, val);
	});
};
var checkOverrides = false;
for(var k in servOptMap) {
	servOptHelper(k, argv[k], 'post', ulOpts.servers.filter(function(server) {
		// set options if posting is (or will be) enabled
		return (!defNumConnPost && argv.connections) || server.postConnections;
	}));
	if(argv['check-' + k] !== null && argv['check-' + k] !== undefined) {
		if(k == 'connections') {
			// connections is special in that it's not an override
			ulOpts.servers.forEach(function(server) {
				if(!defNumConnCheck || server.checkConnections)
					server.checkConnections = argv['check-' + k];
			});
		} else {
			checkOverrides = true;
		}
	}
}
if(checkOverrides && argv['check-connections'] !== 0 && (defNumConnCheck || argv['check-connections'])) {
	// go through servers, find ones with check connections enabled, and split out
	var chkServ = [], addServ = [];
	ulOpts.servers.forEach(function(server) {
		if(!defNumConnCheck || server.checkConnections) {
			if(server.postConnections) {
				// split this server into two parts - one for checking, other for posting
				var copy = JSON.parse(JSON.stringify(server));
				copy.postConnections = 0;
				chkServ.push(copy);
				addServ.push(copy);
				server.checkConnections = 0;
			} else {
				// this server is only used for checking, no need to split
				chkServ.push(server);
			}
		}
	});
	
	for(var k in servOptMap) {
		servOptHelper(k, argv['check-' + k], 'check', chkServ);
	}
	
	ulOpts.servers = ulOpts.servers.concat(addServ);
}

if(argv['post-chunk-size']) {
	// if a chunk size is explicitly supplied, disable the auto chunk-size scaler
	ulOpts.servers.forEach(function(server) {
		server.throttleChunkTime = 0;
	});
}

if(argv['dump-failed-posts']) {
	try {
		if(fs.statSync(argv['dump-failed-posts']).isDirectory()) {
			// if supplied a folder, append a directory separator if not supplied
			var sep = require('path').sep;
			if(ulOpts.dumpPostLoc.substr(-1) != sep)
				ulOpts.dumpPostLoc += sep;
		}
	} catch(x) {}
}

if(argv['copy-input']) {
	var copyIncl, copyExcl, copyTarget = argv['copy-input'];
	var reFlags = process.platform == 'win32' ? 'i' : '';
	if(argv['copy-include'])
		copyIncl = new RegExp(argv['copy-include'], reFlags);
	if(argv['copy-exclude'])
		copyExcl = new RegExp(argv['copy-exclude'], reFlags);
	
	var copyProc = copyTarget.match(/^proc:\/\//i);
	if(copyProc)
		copyTarget = copyTarget.substr(7);
	
	ulOpts.inputCopy = function(filename, size) {
		if(copyIncl && !filename.match(copyIncl)) return;
		if(copyExcl && filename.match(copyExcl)) return;
		
		var target = copyTarget.replace(/\{(filename|size)\}/ig, function(m, token) {
			return token == 'filename' ? filename : size;
		});
		if(copyProc) {
			return processStart('Copy', target, {stdio: ['pipe','ignore','ignore']}).stdin;
		} else {
			return fs.createWriteStream(target);
		}
	};
}

// map custom headers
if(argv.header) {
	// to preserve case, build case-insensitive lookup
	var headerCMap = {};
	for(var k in ulOpts.postHeaders)
		headerCMap[k.toLowerCase()] = k;
	
	for(var k in argv.header) {
		// handle casing wierdness
		var kk = headerCMap[k.toLowerCase()];
		if(!kk) {
			headerCMap[k.toLowerCase()] = kk = k;
		}
		ulOpts.postHeaders[kk] = argv.header[k];
	}
}

// map custom meta tags
if(argv.meta) util.extend(ulOpts.nzb.metaData, argv.meta);

if(ulOpts.connectionThreads) {
	var numConnections = 0;
	ulOpts.servers.forEach(function(server) {
		if(server.postConnections) {
			if(server.throttleRate && (server.throttleRate.size || server.throttleRate.time))
				error('Upload throttling is not supported with connection threading');
			server.useThreads = true;
			numConnections += server.postConnections;
		}
	});
	if(numConnections) {
		var threadPool = require('../lib/sockthread');
		threadPool.createPool(Math.min(numConnections, ulOpts.connectionThreads));
		process.once('finished', threadPool.closePool);
		ulOpts.useSharedBuffers = true; // reduce copying when sending posts to threads
	}
}

if(argv['preload-modules']) {
	require('net'); // tls requires it, so may as well...
	ulOpts.servers.forEach(function(server) {
		if(server.secure) require('tls');
	});
	// we won't consider modules loaded by the UploadManager constructor (zlib, nzbbuffer, bufferpool, procman) as 'too late', since it occurs before the 'start' event is fired, hence won't bother preloading these here
}

// if doing raw posts, default keepMessageId to true
if(argv['input-raw-posts'] && argv['keep-message-id'] !== false)
	ulOpts.keepMessageId = true;

if(argv['out']) {
	if(argv['out'] == '-') {
		ulOpts.nzb.writeTo = process.stdout;
	} else if(/^fd:\/\/\d+$/i.test(argv['out'])) {
		ulOpts.nzb.writeTo = fs.createWriteStream(null, {fd: argv['out'].substr(5)|0, encoding: ulOpts.nzb.writeOpts.encoding});
	} else {
		var outTokens = RE_FILE_TRANSFORM.test(argv['out']);
		var nzbOpts = ulOpts.nzb;
		if(outTokens) delete nzbOpts.writeTo;
		if(/^proc:\/\//i.test(argv['out'])) {
			var proc = argv['out'].substr(7);
			if(outTokens) {
				var tr = fileTransformFn(proc), procsStarted = {};
				ulOpts.nzb = function() {
					var proc = tr.apply(null, arguments);
					if(!procsStarted[proc])
						procsStarted[proc] = processStart('NZB', proc, {stdio: ['pipe','ignore','ignore']}).stdin;
					var opts = {writeTo: procsStarted[proc]};
					for(var k in nzbOpts)
						opts[k] = nzbOpts[k];
					return [proc, opts];
				};
			} else {
				ulOpts.nzb.writeTo = function(cmd) {
					return processStart('NZB', cmd, {stdio: ['pipe','ignore','ignore']}).stdin;
					// if process exits early, the write stream should break and throw an error
				}.bind(null, proc);
			}
		} else if(outTokens) {
			var tr = fileTransformFn(argv['out']);
			ulOpts.nzb = function() {
				var opts = {writeTo: tr.apply(null, arguments)};
				for(var k in nzbOpts)
					opts[k] = nzbOpts[k];
				return [opts.writeTo, opts];
			};
		}
	}
}
// custom validation rules
// TODO: more validation

if(argv.quiet && argv.verbose)
	error('Cannot specify both `quiet` and `verbose`');

var verbosity = 3;
if(argv['log-level'] || argv['log-level'] === 0)
	verbosity = argv['log-level'];
else if(argv.quiet)
	verbosity = 2;
else if(argv.verbose)
	verbosity = 4;

var logTimestamp;
if(argv['log-time']) {
	var tzOffset = (new Date()).getTimezoneOffset() * 60000;
	logTimestamp = function(addSpace) {
		return '[' + (new Date(Date.now() - tzOffset)).toISOString().replace('T', ' ').replace('Z', '') + ']' + addSpace;
	};
} else {
	logTimestamp = function(){ return ''; };
}

var progress = [];
var stdErrProgress = false, usingProgressIndicator = false;
if(argv.progress) {
	argv.progress.forEach(function(str) {
		var m = str.match(/^([a-z]+)(:|$)/i);
		if(!m) error('Unknown progress specification: ' + str);
		var type = m[1].toLowerCase();
		var arg = str.substr(m[0].length);
		switch(type) {
			case 'log':
				progress.push({type: 'log', interval: arg_parser.parseTime(arg) || 60*1000});
			break;
			case 'stderr':
			case 'stderrx':
				stdErrProgress = true;
			case 'stdout':
			case 'stdoutx':
				if(usingProgressIndicator) error('Can only specify one of stderr/x and stdout/x');
				usingProgressIndicator = true;
				progress.push({type: type});
				
				if(argv['preload-modules'])
					require('../cli/progrec');
			break;
			case 'tcp':
			case 'http':
				var o = {type: type, port: 0};
				if(arg.substr(0, 5) == 'unix:') {
					o.socket = arg.substr(5);
				} else if(m = arg.match(/^([a-z0-9\-.]*|\[[a-f0-9:]+\]):(\d*)$/i)) {
					if(m[1].length) {
						if(m[1].substr(0, 1) == '[')
							o.host = m[1].substr(1, m[1].length-2);
						else
							o.host = m[1];
					}
					o.port = m[2]|0;
				} else if((arg|0) == arg) {
					o.port = arg|0;
				} else {
					o.host = arg;
				}
				progress.push(o);
				
				if(argv['preload-modules']) {
					if(type == 'http') {
						require('http');
						require('url');
					} else {
						require('net');
					}
				}
			break;
			case 'none':
				// bypass
			break;
			default:
				error('Unknown progress specification: ' + str);
		}
	});
} else if(verbosity >= 3 && process.stderr.isTTY) {
	// default progress bar
	progress.push({type: 'stderr'});
	stdErrProgress = true;
}

var progressMgr = require('../cli/progressmgr');
var writeNewline = function() {
	process.stderr.write('\n');
};
var clrRow = stdErrProgress ? '\x1b[0G\x1B[0K' : '';
var writeLog;
if(argv.colorize) {
	writeLog = function(col, type, msg) {
		process.stderr.write(
			clrRow + '\x1B['+col+'m' + logTimestamp('') + type + '\x1B[39m ' + msg.toString() + '\n'
			+ (progressMgr.getProcessIndicator && stdErrProgress ? progressMgr.getProcessIndicator() : '')
		);
	};
} else {
	writeLog = function(col, type, msg) {
		process.stderr.write(
			clrRow + logTimestamp('') + type + ' ' + msg.toString() + '\n'
			+ (progressMgr.getProcessIndicator && stdErrProgress ? progressMgr.getProcessIndicator() : '')
		);
	};
}
var logger = {
	debug: function(msg) {
		writeLog('36', '[DBG ]', msg);
	},
	info: function(msg) {
		writeLog('32', '[INFO]', msg);
	},
	warn: function(msg) {
		writeLog('33', '[WARN]', msg);
	},
	error: function(msg) {
		writeLog('31', '[ERR ]', msg);
		progressMgr.errorCount++;
	}
};

if(verbosity < 4) logger.debug = function(){};
if(verbosity < 3) logger.info = function(){};
if(verbosity < 2) logger.warn = function(){};
if(verbosity < 1) {
	logger.error = function(){progressMgr.errorCount++;};
	// suppress output from uncaught exceptions
	process.once('uncaughtException', function(err) {
		process.exit(isNode010 ? 8 : 1);
	});
} else {
	Error.stackTraceLimit = 25; // increase limit as I've had cases where 10 entries wasn't enough
	process.once('uncaughtException', function(err) {
		process.emit('finished');
		if(progressMgr.getProcessIndicator)
			process.removeListener('exit', writeNewline);
		progressMgr.getProcessIndicator = null;
		logger.error('Unexpected fatal exception encountered, stack trace below');
		throw err; // this seems to change the exit code a bit :/
	});
}

process.once('finished', function() {
	process.removeAllListeners('finished'); // prevent this executing twice, e.g. due to crash after end
});

var displayCompleteMessage = function(err) {
	if(err)
		Nyuu.log.error(err.toString() + (err.skippable ? ' (use `skip-errors` to ignore)':''));
	else if(progressMgr.errorCount)
		Nyuu.log.info('Process complete, with ' + progressMgr.errorCount + ' error(s)');
	else
		Nyuu.log.info('Process complete');
};

var Nyuu = argv['input-raw-posts'] ? require('../lib/postuploader') : require('../');
Nyuu.setLogger(logger);

var filesToUpload = argv._;

(function(cb) {
	var fileLists = [];
	if(argv['input-file']) {
		fileLists = argv['input-file'].map(function(f) {
			return [f, true];
		});
	}
	if(argv['input-file0']) {
		fileLists = fileLists.concat(argv['input-file0'].map(function(f) {
			return [f, false];
		}));
	}
	
	if(fileLists) {
		var stdInUsed = false;
		var inlistEnc = argv['input-file-enc'];
		require('async').map(fileLists, function(fl, cb) {
			if(fl[0] == '-' || /^fd:\/\/\d+$/i.test(fl[0])) {
				var stream;
				if(fl[0] == '-') {
					if(stdInUsed) error('stdin was specified as input for multiple sources');
					stdInUsed = true;
					stream = process.stdin;
				} else {
					stream = fs.createReadStream(null, {fd: fl[0].substr(5)|0});
				}
				// read from stream
				var data = '';
				stream.on('data', function(chunk) {
					data += chunk.toString(inlistEnc);
				});
				stream.once('end', function() {
					cb(null, [fl[1], data]);
				});
				stream.once('error', cb);
			} else if(/^proc:\/\//i.test(fl[0])) {
				require('child_process').exec(fl[0].substr(7), {maxBuffer: 1048576*32, encoding: inlistEnc}, function(err, stdout, stderr) {
					if(stderr && stderr.length && verbosity >= 4 && !err) {
						logger.debug('File list process outputted to stderr: ' + stderr.toString(inlistEnc));
					}
					cb(err, [fl[1], stdout]);
				});
			} else {
				fs.readFile(fl[0], function(err, data) {
					cb(err, [fl[1], data ? data.toString(inlistEnc) : null]);
				});
			}
		}, function(err, dataPairs) {
			if(err) return error(err);
			dataPairs.forEach(function(data) {
				if(data[0])
					filesToUpload = filesToUpload.concat(
						data[1].replace(/\r/g, '').split('\n').filter(function(l) {
							return l !== '';
						})
					);
				else
					filesToUpload = filesToUpload.concat(data[1].replace(/\0$/, '').split('\0'));
			});
			cb();
		});
	} else cb();
})(function() {
	if(!filesToUpload.length)                  error('Must supply at least one input file');
	
	var fuploader = Nyuu.upload(filesToUpload.map(function(file) {
		// TODO: consider supporting deferred filesize gathering?
		var m = file.match(/^procjson:\/\/(.+?,.+?,.+)$/i);
		if(m) {
			if(m[1].substr(0, 1) != '[')
				m[1] = '[' + m[1] + ']';
			m = JSON.parse(m[1]);
			if(!Array.isArray(m) || m.length != 3)
				error('Invalid syntax for process input: ' + file);
			var ret = {
				name: m[0],
				size: Math.floor(m[1]),
				stream: function(cmd) {
					if(typeof cmd == 'number')
						return fs.createReadStream(null, {fd: cmd|0});
					return processStart('Input', cmd, {stdio: ['ignore','pipe','ignore']}).stdout;
				}.bind(null, m[2])
			};
			if(!ret.size)
				error('Invalid size specified for process input: ' + file);
			if(argv['preload-modules']) {
				require('../cli/procman');
				require('../lib/streamreader');
			}
			return ret;
		} else {
			if(argv['preload-modules'])
				require('../lib/filereader');
		}
		return file;
	}), ulOpts, function(err) {
		if(progressMgr.getProcessIndicator)
			process.removeListener('exit', writeNewline);
		process.emit('finished');
		progressMgr.getProcessIndicator = null;
		if(err) {
			displayCompleteMessage(err);
			process.exitCode = 33;
		} else {
			displayCompleteMessage();
			process.exitCode = progressMgr.errorCount ? 32 : 0;
		}
		(function(cb) {
			if(processes && processes.running) {
				var procShutdownDelay = setTimeout(function() {
					if(!processes.running) return;
					Nyuu.log.info(processes.running + ' external process(es) are still running; Nyuu will exit when these do');
					
					// try killing pipes after a 5s wait; unsure if this actually helps anything
					procShutdownDelay = setTimeout(function() {
						processes.closeAll();
					}, 4000).unref();
				}, 1000).unref();
				processes.onEnd(function() {
					clearTimeout(procShutdownDelay);
					cb();
				});
			} else cb();
		})(function() {
			if(isNode010 && process.exitCode) {
				// hack for lack of .exitCode support on node 0.10
				process.on('exit', function() {
					process.exit(process.exitCode);
				});
			}
			setTimeout(function() {
				var handles = cliUtil.activeHandleCounts();
				if(handles) {
					Nyuu.log.warn('Process did not terminate cleanly; active handles: ' + cliUtil.activeHandlesStr(handles[0]));
					if(verbosity >= 4 && handles[1]) {
						process.stderr.write(require('util').inspect(handles[1], {colors: argv.colorize}) + '\n');
					}
				} else
					Nyuu.log.warn('Process did not terminate cleanly');
				process.exit();
			}, 5000).unref();
		});
	});
	
	// display some stats
	fuploader.once('start', function(files, uploader) {
		var totalSize = 0, totalPieces = 0, totalFiles = 0;
		for(var filename in files) {
			var sz = files[filename].size;
			totalSize += sz;
			totalPieces += Math.ceil(sz / ulOpts.articleSize);
			totalFiles++;
		}
		if(argv['input-raw-posts']) {
			totalPieces = totalFiles;
			Nyuu.log.info('Uploading ' + totalPieces + ' article(s) totalling about ' + cliUtil.friendlySize(totalSize));
		} else
			Nyuu.log.info('Uploading ' + totalPieces + ' article(s) from ' + totalFiles + ' file(s) totalling ' + cliUtil.friendlySize(totalSize));
		
		var startTime = Date.now();
		var reportOnEnd = false;
		var getCompleteStatus = function(err) {
			if(reportOnEnd) {
				var now = Date.now();
				
				return (err ? 'Process has been aborted.' : 'Process complete.') + ' Report follows:\n' +
				'         Elapsed time: ' + cliUtil.friendlyTime(now-startTime) + '\n' +
				'         ' + progressMgr.progressReport(now).join('\n         ');
			} else {
				var msg;
				var time = Date.now() - startTime;
				if(err) {
					msg = 'Process has been aborted. Posted ' + uploader.articlesPosted + ' article(s)';
					var unchecked = uploader.articlesPosted - uploader.articlesChecked;
					if(unchecked)
						msg += ' (' + unchecked + ' unchecked)';
					msg += ' in ' + cliUtil.friendlyTime(time) + ' (' + cliUtil.friendlySize(uploader.bytesPosted/time*1000) + '/s)';
				} else {
					msg = 'Finished uploading ' + cliUtil.friendlySize(totalSize) + ' in ' + cliUtil.friendlyTime(time) + ' (' + cliUtil.friendlySize(totalSize/time*1000) + '/s)';
					
					if(progressMgr.errorCount)
						msg += ', with ' + progressMgr.errorCount + ' error(s) across ' + uploader.articleErrors + ' post(s)';
				}
				
				return msg + '. Network upload rate: ' + cliUtil.friendlySize(uploader.currentNetworkUploadBytes()/uploader.currentNetworkUploadTime()*1000) + '/s';
			}
		};
		
		progress.forEach(function(prg) {
			if(prg.type == 'stdoutx' || prg.type == 'stderrx')
				reportOnEnd = true;
			if(prg.type.substr(0, 3) == 'std') {
				// if unexpected exit, force a newline to prevent some possible terminal corruption
				process.on('exit', writeNewline);
			}
		});
		progressMgr.start(progress, uploader, Nyuu.log, totalPieces, totalSize, startTime, ulOpts.articleSize);
		
		displayCompleteMessage = function(err) {
			if(err)
				Nyuu.log.error(err.toString() + (err.skippable ? ' (use `skip-errors` to ignore)':''));
			Nyuu.log.info(getCompleteStatus(err));
		};
		
		process.once('SIGINT', function() {
			Nyuu.log.warn('SIGINT received, aborting...');
			uploader.cancel('Process aborted by user');
		});
	});
	fuploader.on('processing_file', function(file) {
		Nyuu.log.info('Reading file ' + file.name + '...');
	})
	fuploader.once('read_complete', function() {
		Nyuu.log.info('All file(s) read...');
	});
});
