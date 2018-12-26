import { dirname, resolve, extname, normalize, sep } from 'path';
import builtins from 'builtin-modules';
import resolveId from 'resolve';
import isModule from 'is-module';
import fs from 'fs';

var ES6_BROWSER_EMPTY = resolve( __dirname, '../src/empty.js' );
var CONSOLE_WARN = function () {
	var args = [], len = arguments.length;
	while ( len-- ) args[ len ] = arguments[ len ];

	return console.warn.apply( console, args );
}; // eslint-disable-line no-console
// It is important that .mjs occur before .js so that Rollup will interpret npm modules
// which deploy both ESM .mjs and CommonJS .js files as ESM.
var DEFAULT_EXTS = [ '.mjs', '.js', '.json', '.node' ];

var readFileCache = {};
var readFileAsync = function (file) { return new Promise(function (fulfil, reject) { return fs.readFile(file, function (err, contents) { return err ? reject(err) : fulfil(contents); }); }); };
var statAsync = function (file) { return new Promise(function (fulfil, reject) { return fs.stat(file, function (err, contents) { return err ? reject(err) : fulfil(contents); }); }); };
function cachedReadFile (file, cb) {
	if (file in readFileCache === false) {
		readFileCache[file] = readFileAsync(file).catch(function (err) {
			delete readFileCache[file];
			throw err;
		});
	}
	readFileCache[file].then(function (contents) { return cb(null, contents); }, cb);
}

var isFileCache = {};
function cachedIsFile (file, cb) {
	if (file in isFileCache === false) {
		isFileCache[file] = statAsync(file)
			.then(
				function (stat) { return stat.isFile(); },
				function (err) {
					if (err.code == 'ENOENT') { return false; }
					delete isFileCache[file];
					throw err;
				});
	}
	isFileCache[file].then(function (contents) { return cb(null, contents); }, cb);
}

function deprecatedMainField (options, option, mainFields, field) {
	if ( field === void 0 ) field = option;

	if (option in options) {
		CONSOLE_WARN(("node-resolve: setting options." + option + " is deprecated, please override options.mainFields instead"));
		if (options[option] === false) {
			return mainFields.filter(function (mainField) { return mainField === field; });
		} else if (options[option] === true && mainFields.indexOf(field) === -1) {
			return mainFields.concat([field]);
		}
	}
	return mainFields;
}

var resolveIdAsync = function (file, opts) { return new Promise(function (fulfil, reject) { return resolveId(file, opts, function (err, contents) { return err ? reject(err) : fulfil(contents); }); }); };

function nodeResolve ( options ) {
	if ( options === void 0 ) options = {};

	if ('mainFields' in options && ('module' in options || 'main' in options || 'jsnext' in options)) {
		throw new Error("node-resolve: do not use deprecated 'module', 'main', 'jsnext' options with 'mainFields'");
	}
	var mainFields = options.mainFields || ['module', 'main'];
	mainFields = deprecatedMainField(options, 'browser', mainFields);
	mainFields = deprecatedMainField(options, 'module', mainFields);
	mainFields = deprecatedMainField(options, 'jsnext', mainFields, 'jsnext:main');
	mainFields = deprecatedMainField(options, 'main', mainFields);
	var isPreferBuiltinsSet = options.preferBuiltins === true || options.preferBuiltins === false;
	var preferBuiltins = isPreferBuiltinsSet ? options.preferBuiltins : true;
	var customResolveOptions = options.customResolveOptions || {};
	var jail = options.jail;
	var only = Array.isArray(options.only)
		? options.only.map(function (o) { return o instanceof RegExp
			? o
			: new RegExp('^' + String(o).replace(/[\\^$*+?.()|[\]{}]/g, '\\$&') + '$'); }
		)
		: null;
	var browserMapCache = {};

	var onwarn = options.onwarn || CONSOLE_WARN;

	if ( options.skip ) {
		throw new Error( 'options.skip is no longer supported — you should use the main Rollup `external` option instead' );
	}

	if ( !mainFields.length ) {
		throw new Error( "Please ensure at least one 'mainFields' value is specified" );
	}

	var preserveSymlinks;

	return {
		name: 'node-resolve',

		options: function options ( options$1 ) {
			preserveSymlinks = options$1.preserveSymlinks;
		},

		onwrite: function onwrite () {
			isFileCache = {};
			readFileCache = {};
		},

		resolveId: function resolveId$$1 ( importee, importer ) {
			if ( /\0/.test( importee ) ) { return null; } // ignore IDs with null character, these belong to other plugins

			// disregard entry module
			if ( !importer ) { return null; }

			if (mainFields.indexOf('browser') !== -1 && browserMapCache[importer]) {
				var resolvedImportee = resolve( dirname( importer ), importee );
				var browser = browserMapCache[importer];
				if (browser[importee] === false || browser[resolvedImportee] === false) {
					return ES6_BROWSER_EMPTY;
				}
				if (browser[importee] || browser[resolvedImportee] || browser[resolvedImportee + '.js'] || browser[resolvedImportee + '.json']) {
					importee = browser[importee] || browser[resolvedImportee] || browser[resolvedImportee + '.js'] || browser[resolvedImportee + '.json'];
				}
			}


			var parts = importee.split( /[/\\]/ );
			var id = parts.shift();

			if ( id[0] === '@' && parts.length ) {
				// scoped packages
				id += "/" + (parts.shift());
			} else if ( id[0] === '.' ) {
				// an import relative to the parent dir of the importer
				id = resolve( importer, '..', importee );
			}

			if (only && !only.some(function (pattern) { return pattern.test(id); })) { return null; }

			var disregardResult = false;
			var packageBrowserField = false;
			var extensions = options.extensions || DEFAULT_EXTS;

			var resolveOptions = {
				basedir: dirname( importer ),
				packageFilter: function packageFilter ( pkg, pkgPath ) {
					var pkgRoot = dirname( pkgPath );
					if (mainFields.indexOf('browser') !== -1 && typeof pkg[ 'browser' ] === 'object') {
						packageBrowserField = Object.keys(pkg[ 'browser' ]).reduce(function (browser, key) {
							var resolved = pkg[ 'browser' ][ key ] === false ? false : resolve( pkgRoot, pkg[ 'browser' ][ key ] );
							browser[ key ] = resolved;
							if ( key[0] === '.' ) {
								var absoluteKey = resolve( pkgRoot, key );
								browser[ absoluteKey ] = resolved;
								if ( !extname(key) ) {
									extensions.reduce( function ( browser, ext ) {
										browser[ absoluteKey + ext ] = browser[ key ];
										return browser;
									}, browser );
								}
							}
							return browser;
						}, {});
					}

					var overriddenMain = false;
					for ( var i in mainFields ) {
						var field = mainFields[i];
						if ( typeof pkg[ field ] === 'string' ) {
							pkg[ 'main' ] = pkg[ field ];
							overriddenMain = true;
							break;
						}
					}
					if ( overriddenMain === false && mainFields.indexOf( 'main' ) === -1 ) {
						disregardResult = true;
					}
					return pkg;
				},
				readFile: cachedReadFile,
				isFile: cachedIsFile,
				extensions: extensions
			};

			if (preserveSymlinks !== undefined) {
				resolveOptions.preserveSymlinks = preserveSymlinks;
			}

			return resolveIdAsync(
				importee,
				Object.assign( resolveOptions, customResolveOptions )
			)
				.catch(function () { return false; })
				.then(function (resolved) {
					if (mainFields.indexOf('browser') !== -1 && packageBrowserField) {
						if (packageBrowserField[ resolved ]) {
							resolved = packageBrowserField[ resolved ];
						}
						browserMapCache[resolved] = packageBrowserField;
					}

					if ( !disregardResult && resolved !== false ) {
						if ( !preserveSymlinks && resolved && fs.existsSync( resolved ) ) {
							resolved = fs.realpathSync( resolved );
						}

						if ( ~builtins.indexOf( resolved ) ) {
							return null;
						} else if ( ~builtins.indexOf( importee ) && preferBuiltins ) {
							if ( !isPreferBuiltinsSet ) {
								onwarn(
									"preferring built-in module '" + importee + "' over local alternative " +
									"at '" + resolved + "', pass 'preferBuiltins: false' to disable this " +
									"behavior or 'preferBuiltins: true' to disable this warning"
								);
							}
							return null;
						} else if ( jail && resolved.indexOf( normalize( jail.trim( sep ) ) ) !== 0 ) {
							return null;
						}
					}

					if ( resolved && options.modulesOnly ) {
						return readFileAsync( resolved, 'utf-8').then(function (code) { return isModule( code ) ? resolved : null; });
					} else {
						return resolved === false ? null : resolved;
					}
				});
		}
	};
}

export default nodeResolve;
