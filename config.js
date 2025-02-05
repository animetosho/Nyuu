/**** Nyuu options/config file ****/
// This file contains all the default options for Nyuu
// You can customize these options to avoid having to specify them on the command line, however it is recommended that you not edit this file
// It is strongly recommended that you create a config file and supply it to Nyuu via the `--config` option, see config-sample.json for an example
// If the .json config file isn't sufficient, you can copy this file elsewhere and still use the `--config` option to read it. Missing options there will sourced from this file
// WARNING: this file is not maintained for backwards compatibility; this means that you'll need to re-set all custom options every time Nyuu is upgraded!

module.exports = {



/** Upload Server Options **/
servers: [
	{
		// connection options - see the following pages for full documentation
		// non-SSL: https://nodejs.org/api/net.html#net_socket_connect_options_connectlistener
		// SSL: https://nodejs.org/api/tls.html#tls_tls_connect_options_callback
		connect: { // connection options
			host: 'localhost',
			port: null, // null => if server.secure, port=563, else, port=119
			
			// SSL options
			rejectUnauthorized: true,
		},
		secure: false, // set to true to use SSL
		user: '',
		password: '',
		// note that these times are specified in milliseconds
		timeout: 30000, // 30000ms = 30 seconds
		connTimeout: 30000, // 30 seconds
		postTimeout: 120000, // 2 minutes
		reconnectDelay: 15000, // 15 seconds
		connectRetries: 1,
		requestRetries: 5, // how many times to retry an interrupted request
		retryBadResp: false, // enable retrying if a bad response is received
		postRetries: 1, // how many times to retry if server returns 441 response to posted article
		postRetryDelay: 0, // delay post retries (above option) by this many milliseconds
		postFailReconnect: false, // treat post failure like a connection-level error; postRetries and postRetryDelay settings are ignored if true
		errorTeardown: false, // false = gracefully close bad connections, true = forcefully destroy them
		closeTimeout: 5000, // 5 seconds; wait period before forcefully dropping gracefully closed connections
		keepAlive: false, // always reconnect on error, even if not needed
		onPostTimeout: null, // list of actions (strings) to take if server sends no response to a post; values can be 'retry', 'strip-hdr=X' and 'ignore'; if not set (null), defaults to ['retry','retry','retry'...] where the number of elements == requestRetries
		tcpKeepAlive: false, // false to disable, otherwise set a number for probe interval (in ms)
		uploadChunkSize: 192*1024, // break up post into chunks of this size when uploading; 0 to disable chunking
		postMethod: 'POST', // command to use when posting; can be POST, IHAVE, XREPLIC or TAKETHIS
		
		// for throttling upload speed - this throttle is shared among all posting connections for this server config
		// set either to 0 to disable speed throttling
		throttleRate: {
			size: 0, // size in bytes to signify target maximum amount of data to send...
			time: 0  // ...within this time period (milliseconds)
		},
		throttleChunkTime: 2000, // if throttling is enabled, uploadChunkSize != 0 and it would take longer than this amount of milliseconds to send a chunk, at specified throttle rate, reduce the chunk size to a 4KB multiple to suit; set this to 0 to disable
		
		postConnections: 3, // number of connections for posting
		checkConnections: 0, // number of connections used for checking
		// TODO: consider ability to reuse posting connections for checking?
		//ulConnReuse: false, // use uploading connections for post checks; only works if checking the same server as the one being uploaded to
	},
],
// multiple servers can be specified by adding elements to tbe above array, but note that:
// - specifying options via the CLI may get confusing
// - servers are currently selected randomly for posting/checking; Nyuu won't otherwise do anything special if you specify multiple servers (this includes falling over if a server is misbehaving)

connectionThreads: 0, // number of threads to distribute posting connections over

/** Post Check Options **/
check: {
	delay: 5000, // (in ms) initial delay for performing check
	recheckDelay: 30000, // (in ms) delay retries by this amount of time; not used if tries<2
	tries: 2, // number of check attempts; should be 0 if not performing post checks
	group: '', // if set, will switch checking connections to this group; some servers seem to want one when STATing posts, otherwise they fail to show them; if set, should be a valid group you never post to, eg "bit.test"
	postRetries: 1, // maximum number of post retry attempts after a post check failure; set to 0 to never retry posting
	queueCache: null, // maximum number of cached posts in the post-check queue; if this number is exceeded, posts are dropped from cache if possible; if posts cannot be dropped from cache, this value acts like queueBuffer and will pause uploading when full. Caching is only useful if posts need to be re-posted due to a failure condition, in which case, uncached posts need to be re-generated off disk; default 5 or min(connections*8,100) if unseekable streams are used
	queueBuffer: 10000, // maximum number of posts in the post-check queue; if this number is exceeded, uploading is paused until the queue is emptied below this size
},

skipErrors: [], // list of errors to skip; can be set to true to imply all errors; valid options are 
maxPostErrors: 0, // if > 0, maximum number of failed articles to allow before aborting
useLazyConnect: false, // if true, will only create connections when needed, rather than pre-emptively doing so

/** Post/Article Options **/
articleSize: 716800, // in bytes
bytesPerLine: 128, // in bytes, note: as per yEnc specifications, it's possible to exceed this number
articleEncoding: 'utf8', // must be an "8-bit charset" (i.e. not utf16 or the like)
yencName: null, // set this to a function to overwrite/customise the 'name' field in the yEnc header; arguments are same as those for 'postHeaders' functions, with the 'part' argument always being 1

postDate: null, // if set, override timestamps used for Message-ID header, Date header and NZB timestamps
keepMessageId: false, // if true, don't randomize Message-ID header every time the post is submitted; if custom function supplied for Message-ID, it is called when it is to be regenerated
comment: '', // subject pre-comment
comment2: '', // subject post-comment
groupFiles: false, // group "similar" files (based on filename) together into sub-collections, similar to how usenet indexers would do it; only affects the file counter in the subject line

// if any of the following are functions, they'll be called with args(filenum, filenumtotal, filename, size, part, parts)
// - if the function returns null/undefined, the header is not sent
// Note: for Message-ID (if the keepMessageId option is true), the function should return strings that wont't vary in length for the same post, as Nyuu requires same length Message IDs to be used when re-generating the ID
postHeaders: {
	// required headers
	'Message-ID': null, // default: auto-generated
	Subject: null, // if null, a default Subject is used
	From: (process.env.USER || process.env.USERNAME || 'user').replace(/[<>]/g, '') + ' <' + ((process.env.USER || process.env.USERNAME || '').replace(/[" (),:;<>@]/g, '') || 'user') + '@' + (require('os').hostname().replace(/[^a-z0-9_.\-]/ig, '').match(/^([a-z0-9][a-z0-9\-]*\.)*[a-z0-9][a-z0-9\-]*$/i) || ['nyuu.uploader'])[0].replace(/^([^.])+$/, '$1.localdomain') + '>', // 'A Poster <a.poster@example.com>'
	Newsgroups: 'alt.binaries.test', // comma seperated list
	Date: null, // if null, value is auto-generated from when post is first generated
	Path: '',
	
	// optional headers
	//Organization: '',
	'User-Agent': 'Nyuu/' + (global.__nyuu_pkg || require('./package.json')).version,
	// nice list of headers: https://www.cotse.net/privacy/newsgroup_header.htm or http://www.cs.tut.fi/~jkorpela/headers.html
},
// postHeaders can also, itself, be a function, in which case, it is called with (filenum, filenumtotal, filename, size, part [always 1], parts) as arguments, and must return an object like the above

/** NZB Options **/
nzb: {
	writeTo: null, // supply a writable stream (or function which returns one) or filename for NZB output
	writeOpts: { // for details, https://nodejs.org/api/fs.html#fs_fs_createwritestream_path_options
		//mode: 0666,
		flags: 'wx', // change to 'w' to overwrite file if it exists
		encoding: 'utf-8',
	},
	fileMode: 'stream', // can be 'stream', 'defer' (only write at end) or 'temp' (write to temp file, rename on end)
	overrides: {
		// here you can override values for NZB <file> entries
		// if unset, will use the NNTP header values from the first segment of the file
		// can be set to a function, which will be called with args(filenum, filenumtotal, filename, size, part [always 1], parts, header_value)
		subject: null, // Subject header
		poster: null, // From header
		date: null, // timestamp when post was generated (note: will be interpreted as a Javascript date)
		groups: null // Newsgroups header
	},
	minify: false,
	compression: '', // can be 'gzip', 'zlib', 'deflate', 'brotli' or '' (none)
	compressOpts: {}, // options for zlib, see https://nodejs.org/api/zlib.html#zlib_class_options
	metaData: {
		// eg:
		// password: 'mysecret',
		// tag: ['SD', 'H.264'],
	},
	corkOutput: false, // cork the output stream (node >=0.12); is here until we have better support for output buffering
},
// the above can also be a function which returns an NZB specification - this allows multiple NZBs to be generated
// the function takes args(filenum, filenumtotal, filename, filesize, part [always 1], parts) and must return an array pair [key, spec] OR a falsey value to indicate no NZB creation
// see the following example for more details
/*
nzb: function(filenum, filenumtotal, filename, filesize) {
	if(filesize < 8192) return; // don't add files < 8KB to NZB
	
	return [
		filename, // the key is used to group files into an NZB; use the same key for files you want to be in the same NZB
		// (in this example, every file is put into a new NZB)
		{ // this is the specification of the NZB to output to; it uses the same syntax as shown above
			writeTo: filename + '.nzb',
			writeOpts: {flags: 'w'}
		}
	];
},
*/
nzbDelIncomplete: false, // if process finishes without completing the NZB, remove it; only applies if it's being written to a file

/** Input Stream Copy/Tee Options **/
inputCopy: null, // a writable stream to copy the input to, or a function (see example below)
/* this example excludes PAR2 files from being copied
inputCopy: function(filename, filesize) {
	if(!filename.match(/\.par2$/i))
		return fs.createWriteStream(filename + '.pipe');
}
*/
copyQueueBuffer: 4, // number of article-sized chunks to buffer to copied streams

/** Tuning Options **/
useBufferPool: true, // self manage article buffers rather than rely on GC's management; also improves performance of writing to buffers
headerAllocSize: 4096, // amount of buffer space to allocate for post headers, only used if useBufferPool is true

diskReqSize: null, // chunk size when reading from disk; default = Math.ceil(1048576/articleSize)*articleSize
diskBufferSize: 1, // number of chunks to buffer
articleQueueBuffer: null, // number of buffered articles; default is min(round(numConnections*0.5),25)

/** Other Options **/
subdirs: 'include', // can be 'skip', 'include' or 'keep'; note that it affects directly passed directories too
skipSymlinks: false, // ignore all symlinks
processEmptyFiles: false, // don't skip 0 byte files
// filenames will be transformed according to the following setting, which is a function that will have the file's path and name passed to it
// the default is to keep the filename component only, which essentially flattens all files into a single directory
// this is similar to how other clients handle folders
// you can also return false from this function to skip specific files
fileNameTransform: require('path').basename,
// another example: include path, seperated by dashes (e.g. "MyFolder - SubFolder - SomeFile.txt")
// fileNameTransform: function(fileName) { return path.dirname(fileName).replace(path.sep == '\\' ? /\\\\/g : new RegExp(path.sep, 'g'), ' - ') + path.basename(fileName); },


dumpPostLoc: '', // dump all failed articles to this location (the Message-ID will be appended to this, so if you want to store in a directory, end this with a trailing slash); only useful for debugging


// only used for raw post uploading; delete successfully uploaded post files
deleteRawPosts: false,


// CLI UI options - these are equivalent to options in the JSON config - see help-full.txt for details
cli: {
	colorize: process.stderr.isTTY,
	'log-level': 3, // 1=error, 2=warning (quiet), 3=info, 4=debug (verbose)
	'log-time': false,
	progress: null, // array of strings, describing enabled progress indicators
	'input-file': null, // array of strings
	'input-file0': null, // array of strings
	'input-file-enc': 'utf8',
	'preload-modules': false,
	'input-raw-posts': false,
},

isFullConfig: true // leave here to indicate that this is a full config file, as opposed to the simplified config file
};
