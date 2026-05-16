var os = require('os');

// -- change these variables if desired --
var compileConcurrency = os.cpus().length;
var python = null;
// process.env.path = '' + process.env.path; // if need to specify a Python path
var buildArch = process.env.BUILD_ARCH || os.arch(); // x86 or x64
var buildOs = process.env.BUILD_OS || os.platform();
var nexeBase = './build';
var nodeVer = process.env.BUILD_NODEVER || '12.22.12';
var staticness = process.env.BUILD_STATIC || '--fully-static'; // set to '--partly-static' if building with glibc
var vsSuite = null; // if on Windows, and it's having trouble finding Visual Studio, try set this to, e.g. 'vs2019' or 'vs2017'
// downloads can be disabled by editing the 'sourceUrl' line below; source code needs to be placed in `${nexeBase}/${nodeVer}`

var yencSrc = './node_modules/yencode/';
var nexe = require('nexe');
var path = require('path');
var fs = require('fs');
var browserify = require('browserify');
var pkg = require('../package.json');


const copyRecursiveSync = function(src, dest) {
	if(fs.statSync(src).isDirectory()) {
		if(!fs.existsSync(dest)) fs.mkdirSync(dest);
		fs.readdirSync(src).forEach(function(child) {
			copyRecursiveSync(path.join(src, child), path.join(dest, child));
		});
	} else
		fs.copyFileSync(src, dest);
};


// create embeddable help
fs.writeFileSync('../bin/help.json', JSON.stringify({
	full: fs.readFileSync('../help-full.txt').toString(),
	short: fs.readFileSync('../help.txt').toString()
}));

// bundle Nyuu into a single JS file
// TODO: maybe explore copying all files instead, instead of bundling
let b = browserify(['../bin/nyuu.js'], {
	debug: false,
	detectGlobals: true,
	node: true
});
['yencode','worker_threads'].forEach(exclude => {
	b.exclude(exclude);
});


// invoke nexe
// --without-corepack
var configureArgs = [staticness, '--without-dtrace', '--without-etw', '--without-npm', '--with-intl=none', '--without-report', '--without-node-options', '--without-inspector', '--without-siphash', '--dest-cpu=' + buildArch];
var vcbuildArgs = ["nosign", buildArch, "noetw", "intl-none", "release", "static"];
// --v8-lite-mode ?
if(parseFloat(nodeVer) >= 8) {
	configureArgs.push('--without-intl');
	vcbuildArgs.push('without-intl');
}
if(parseFloat(nodeVer) >= 10) {
	if(buildOs == 'linux')
		configureArgs.push('--enable-lto');
	if(buildOs == 'win32') {
		configureArgs.push('--with-ltcg');
		vcbuildArgs.push('ltcg', 'no-cctest');
	}
} else {
	configureArgs.push('--without-perfctr');
	vcbuildArgs.push('noperfctr');
}
if(vsSuite) vcbuildArgs.push(vsSuite);

if(process.env.BUILD_CONFIGURE)
	configureArgs = configureArgs.concat(process.env.BUILD_CONFIGURE.split(' '));
if(process.env.BUILD_VCBUILD)
	vcbuildArgs = vcbuildArgs.concat(process.env.BUILD_VCBUILD.split(' '));

var v8gyp = parseFloat(nodeVer) >= 12 ? 'tools/v8_gypfiles/v8.gyp' : (parseFloat(nodeVer) >= 10 ? 'deps/v8/gypfiles/v8.gyp' : 'deps/v8/src/v8.gyp');

nexe.compile({
	input: null, // we'll overwrite _third_party_main instead
	name: 'nyuu',
	target: buildOs+'-'+buildArch+'-'+nodeVer,
	build: true,
	mangle: false,
	bundle: false,
	python: python,
	flags: [], // runtime flags
	configure: configureArgs,
	make: ['-j', compileConcurrency],
	vcBuild: vcbuildArgs,
	snapshot: null, // TODO: consider using this
	temp: nexeBase,
	rc: {
		ProductName: pkg.name,
		FileDescription: pkg.description,
		FileVersion: pkg.version,
		ProductVersion: pkg.version,
		InternalName: 'nyuu',
		CompanyName: 'Anime Tosho'
	},
	//fakeArgv: 'nyuu',
	//sourceUrl: '<disable_download>',
	loglevel: process.env.BUILD_LOGLEVEL || 'info',
	
	patches: [
		// remove nexe's boot-nexe code + fix argv
		async (compiler, next) => {
			var bootFile = 'lib/internal/bootstrap_node.js';
			if(parseFloat(nodeVer) >= 12)
				bootFile = 'lib/internal/bootstrap/pre_execution.js';
			else if(parseFloat(nodeVer) >= 10)
				bootFile = 'lib/internal/bootstrap/node.js';
			
			if(parseFloat(nodeVer) >= 12) {
				// TODO: is the double'd javascript entry (by nexe) problematic?
				await compiler.replaceInFileAsync(bootFile, /(initializePolicy|initializeFrozenIntrinsics)\(\);\s*!\(function.+?new Module.+?\}\)\(\);/s, "$1();");
				
				// fix argv
				await compiler.replaceInFileAsync(bootFile, /patchProcessObject\(expandArgv1\);/, 'patchProcessObject(false); if(!process.send) process.argv.splice(1,0,"nyuu");');
			}
			
			// I don't get the point of the fs patch, so just remove it...
			await compiler.replaceInFileAsync(bootFile, /if \(true\) \{.+?__nexe_patch\(.+?\}\n/s, '');
			
			return next();
		},
		
		// fix worker thread with third_party_main
		async (compiler, next) => {
			await compiler.replaceInFileAsync('src/node.cc', /StartExecution\(env, "internal\/main\/run_third_party_main"\)/, 'StartExecution(env, env->worker_context() == nullptr ? "internal/main/run_third_party_main" : "internal/main/worker_thread")');
			return next();
		},
		
		// fix for building on Alpine
		// https://gitlab.alpinelinux.org/alpine/aports/-/issues/8626
		async (compiler, next) => {
			if(parseFloat(nodeVer) >= 12) {
				await compiler.replaceInFileAsync(v8gyp, /('target_defaults': \{)( 'cflags': \['-U_FORTIFY_SOURCE'\],)?/, "$1 'cflags': ['-U_FORTIFY_SOURCE'],");
			} else {
				await compiler.replaceInFileAsync(v8gyp, /('target_defaults': {'cflags': \['-U_FORTIFY_SOURCE'\]}, )?'targets': \[/, "'target_defaults': {'cflags': ['-U_FORTIFY_SOURCE']}, 'targets': [");
			}
			await compiler.replaceInFileAsync('node.gyp', /('target_name': '(node_mksnapshot|mkcodecache|<\(node_core_target_name\)|<\(node_lib_target_name\))',)( 'cflags': \['-U_FORTIFY_SOURCE'\],)?/g, "$1 'cflags': ['-U_FORTIFY_SOURCE'],");
			return next();
		},
		
		// Xcode 15+ (Clang 15+) promotes -Wenum-constexpr-conversion to an error, breaking V8 in Node 12
		async (compiler, next) => {
			if(buildOs == 'darwin' || buildOs == 'mac') {
				// '-Wenum-constexpr-conversion' available in Clang 16, not in 15, but doesn't error there
				// not recognised by GCC, but it doesn't mind unknown '-Wno-*' flags
				await compiler.replaceInFileAsync('common.gypi', /'WARNING_CFLAGS': \[(\s*'-Wno-enum-constexpr-conversion',)?/, "'WARNING_CFLAGS': [ '-Wno-enum-constexpr-conversion',");
			}
			return next();
		},
		
		// add yencode into source list
		async (compiler, next) => {
			var bindingsFile;
			if(parseFloat(nodeVer) >= 12) {
				await compiler.replaceInFileAsync('node.gyp', /('deps\/histogram\/histogram\.gyp:histogram')(,'deps\/yencode\/binding\.gyp:yencode')?/g, "$1,'deps/yencode/binding.gyp:yencode'");
				bindingsFile = 'src/node_binding.cc';
			} else if(parseFloat(nodeVer) >= 10) {
				await compiler.replaceInFileAsync('node.gyp', /('target_name': '<\(node_lib_target_name\)',)('dependencies': \['deps\/yencode\/binding\.gyp:yencode'\], )?/g, "$1'dependencies': ['deps/yencode/binding.gyp:yencode'], ");
				bindingsFile = 'src/node_internals.h';
			} else {
				await compiler.replaceInFileAsync('node.gyp', /('target_name': '<\(node_lib_target_name\)',[^}]*?'dependencies': \[)('deps\/yencode\/binding\.gyp:yencode', )?/g, "$1'deps/yencode/binding.gyp:yencode', ");
				bindingsFile = 'src/node_internals.h';
			}
			
			// also add it as a valid binding
			await compiler.replaceInFileAsync(bindingsFile, /(V\(async_wrap\))( V\(yencode\))?/, "$1 V(yencode)");
			
			// patch module whitelist
			if(parseFloat(nodeVer) >= 12) {
				// avoid nexe's methods to prevent double-writing this to node.gyp
				const loaderFile = path.join(compiler.src, 'lib/internal/bootstrap/loaders.js');
				data = fs.readFileSync(loaderFile).toString();
				data = data.replace(/('async_wrap',)( 'yencode',)?/, "$1 'yencode',");
				fs.writeFileSync(loaderFile, data);
			}
			
			return next();
		},
		// copy yencode sources
		async (compiler, next) => {
			const dst = path.join(compiler.src, 'deps', 'yencode');
			if(!fs.existsSync(path.join(dst, 'binding.gyp')))
				copyRecursiveSync(yencSrc, dst);
			
			// patch yencode
			var data = await compiler.readFileAsync('deps/yencode/src/yencode.cc');
			data = data.contents.toString();
			data = data.replace(/#if NODE_VERSION_AT_LEAST\(10, 7, 0\).+?NODE_MODULE_INIT.+?#endif/s,
`#define NODE_WANT_INTERNALS 1
#include "../../../src/node_internals.h"
#include <uv.h>
static uv_once_t init_once = UV_ONCE_INIT;
void yencode_init(Local<Object> exports, Local<Value> module, Local<Context> context, void* priv)`
			);
			if(parseFloat(nodeVer) >= 12) {
				data = data.replace(/(\nNODE_MODULE_CONTEXT_AWARE_INTERNAL\(yencode, yencode_init\))?$/, "\nNODE_MODULE_CONTEXT_AWARE_INTERNAL(yencode, yencode_init)");
			} else {
				data = data.replace(/(\nNODE_BUILTIN_MODULE_CONTEXT_AWARE\(yencode, yencode_init\))?$/, "\nNODE_BUILTIN_MODULE_CONTEXT_AWARE(yencode, yencode_init)");
			}
			await compiler.setFileContentsAsync('deps/yencode/src/yencode.cc', data);
			
			data = await compiler.readFileAsync('deps/yencode/index.js');
			data = data.contents.toString();
			data = data.replace(/require\('[^'"]*\/([0-9a-z_]+)\.node'\)/g, "process.binding('$1')");
			//fs.writeFileSync(path.join(compiler.src, 'lib', 'yencode.js'), data);
			await compiler.setFileContentsAsync('lib/yencode.js', data);
			
			data = await compiler.readFileAsync('deps/yencode/binding.gyp');
			data = data.contents.toString();
			data = data.replace(/"target_name": "yencode",( "type": "static_library",)?/, '"target_name": "yencode", "type": "static_library",');
			var includeList = '"../../src", "../v8/include", "../uv/include"';
			if(parseFloat(nodeVer) < 12)
				includeList += ', "../cares/include"';
			data = data.replace(/"include_dirs": \[("\.\.\/\.\.\/src"[^\]]+)?"crcutil/, '"include_dirs": [' + includeList + ', "crcutil');
			data = data.replace(/"enable_native_tuning%": 1,/, '"enable_native_tuning%": 0,');
			await compiler.setFileContentsAsync('deps/yencode/binding.gyp', data);
			
			return next();
		},
		
		// disable unnecessary executables
		async (compiler, next) => {
			await compiler.replaceInFileAsync('node.gyp', /(['"]target_name['"]:\s*['"](cctest|embedtest|fuzz_url|fuzz_env)['"],\s*['"]type['"]:\s*)['"]executable['"]/g, "$1'none'");
			return next();
		},
		// disable exports
		async (compiler, next) => {
			await compiler.replaceInFileAsync('src/node.h', /(define (NODE_EXTERN|NODE_MODULE_EXPORT)) __declspec\(dllexport\)/, '$1');
			await compiler.replaceInFileAsync('src/node_api.h', /(define (NAPI_EXTERN|NAPI_MODULE_EXPORT)) __declspec\(dllexport\)/, '$1');
			await compiler.replaceInFileAsync('src/node_api.h', /__declspec\(dllexport,\s*/g, '__declspec(');
			await compiler.replaceInFileAsync('src/js_native_api.h', /(define NAPI_EXTERN) __declspec\(dllexport\)/, '$1');
			await compiler.replaceInFileAsync('common.gypi', /'BUILDING_(V8|UV)_SHARED=1',/g, '');
			await compiler.setFileContentsAsync('deps/zlib/win32/zlib.def', 'EXPORTS');
			await compiler.replaceInFileAsync(v8gyp, /'defines':\s*\["BUILDING_V8_BASE_SHARED"\],/g, '');
			
			var data = await compiler.readFileAsync('node.gyp');
			data = data.contents.toString();
			data = data.replace(/('use_openssl_def%?':) 1,/, "$1 0,");
			data = data.replace(/'\/WHOLEARCHIVE:[^']+',/g, '');
			data = data.replace(/'-Wl,--whole-archive',.*?'-Wl,--no-whole-archive',/s, '');
			await compiler.setFileContentsAsync('node.gyp', data);
			
			await compiler.replaceInFileAsync('node.gypi', /'force_load%': 'true',/, "'force_load%': 'false',");
			
			return next();
		},
		// patch build options
		async (compiler, next) => {
			var data = await compiler.readFileAsync('common.gypi');
			data = data.contents.toString();
			
			// enable SSE2 as base targeted ISA
			if(buildArch == 'x86' || buildArch == 'ia32') {
				data = data.replace(/('EnableIntrinsicFunctions':\s*'true',)(\s*)('FavorSizeOrSpeed':)/, "$1$2'EnableEnhancedInstructionSet': '2',$2$3");
				data = data.replace(/('cflags': \[)(\s*'-O3')/, "$1 '-msse2',$2");
			}
			
			// MSVC - disable debug info
			data = data.replace(/'GenerateDebugInformation': 'true',/, "'GenerateDebugInformation': 'false',\n'AdditionalOptions': ['/emittoolversioninfo:no'],");
			
			await compiler.setFileContentsAsync('common.gypi', data);
			return next();
		},
		
		
		// strip icon
		async (compiler, next) => {
			await compiler.replaceInFileAsync('src/res/node.rc', /1 ICON node\.ico/, '');
			return next();
		},
		
		// fix for NodeJS 12 on MSVC 2019 x86
		async (compiler, next) => {
			if(parseFloat(nodeVer) >= 12 && parseFloat(nodeVer) < 13 && buildOs == 'win32' && buildArch == 'x86') {
				// for whatever reason, building Node 12 using 2019 build tools results in a horribly broken executable, but works fine in 2017
				// Node's own Windows builds seem to be using 2017 for Node 12.x
				var data = await compiler.readFileAsync('vcbuild.bat');
				data = data.contents.toString();
				data = data.replace('GYP_MSVS_VERSION=2019', 'GYP_MSVS_VERSION=2017'); // seems to be required, even if no MSI is built
				data = data.replace('PLATFORM_TOOLSET=v142', 'PLATFORM_TOOLSET=v141');
				await compiler.setFileContentsAsync('vcbuild.bat', data);
			}
			return next();
		},
		
		// set _third_party_main
		async (compiler, next) => {
			const stream = fs.createWriteStream(compiler.src + '/lib/_third_party_main.js');
			const pipe = b.bundle().pipe(stream);
			return new Promise((resolve, reject) => {
				pipe.once('error', reject);
				stream.once('error', reject);
				stream.once('close', async () => {
					// get nexe to recognise this is added
					await compiler.replaceInFileAsync('lib/_third_party_main.js', /^/, '');
					resolve();
				});
			});
		}
	],
	
}).then(() => {
	console.log('done');
	fs.unlinkSync('../bin/help.json');
	
	// paxmark -m nyuu
	// strip nyuu
	// tar --group=nobody --owner=nobody -cf nyuu-v0.3.8-linux-x86-sse2.tar nyuu ../config-sample.json
	// xz -9e --x86 --lzma2 *.tar
	
});
