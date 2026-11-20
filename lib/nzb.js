"use strict";

var RE_XMLSPECIAL = /[<>&"]/g;
var xmlEscape = function(v) {
	return (v+'').replace(RE_XMLSPECIAL, function(m) {
		switch(m) {
			case '<': return '&lt;';
			case '>': return '&gt;';
			case '&': return '&amp;';
			case '"': return '&quot;';
		}
	});
};

// XML 1.0 (section 2.11) normalizes a raw CR to LF in element content, so an
// encryption password containing U+000D must be written as a character reference.
// LF and TAB survive parsing unchanged in element content and need no escape.
var xmlEscapeCR = function(v) {
	return xmlEscape(v).replace(/\r/g, '&#xD;');
};

var objIsEmpty = function(o) {
	for(var k in o) return false;
	return true;
};

var XmlEncodingMap = {
	UTF8: 'UTF-8', '': 'UTF-8',
	UTF16: 'UTF-16', 'UTF16-LE': 'UTF-16', UTF16LE: 'UTF-16', UCS2: 'UTF-16', 'UCS-2': 'UTF-16',
	LATIN1: 'ISO-8859-1', BINARY: 'ISO-8859-1',
	ASCII: 'US-ASCII'
};

function NZBGenerator(meta, writeFunc, packed, encoding, encrypted) {
	var newline = '\r\n', indent = '\t';
	if(packed)
		newline = indent = '';
	
	this._write = writeFunc;
	this.encoding = encoding || 'utf8';
	
	var data = '';
	
	if(meta && !objIsEmpty(meta)) {
		data = indent + '<head>' + newline;
		for(var k in meta) {
			// only an upload with encryption enabled (the `encrypted` flag, not the meta)
			// writes the encryption password (Body Std §4); archive passwords and
			// user-supplied metas keep the plain escape
			var escape = (k === 'pass' + 'word' && encrypted) ? xmlEscapeCR : xmlEscape;
			(Array.isArray(meta[k]) ? meta[k] : [meta[k]]).forEach(function(value) {
				data += indent + indent + '<meta type="' + xmlEscape(k) + '">' + escape(value) + '</meta>' + newline;
			});
		}
		data += indent + '</head>' + newline;
	}
	
	var xmlEncoding = this.encoding.toUpperCase();
	if(xmlEncoding in XmlEncodingMap)
		xmlEncoding = XmlEncodingMap[xmlEncoding];
	var bom = xmlEncoding == 'UTF-16' ? '\uFEFF' : '';
	this.write(bom + '<?xml version="1.0" encoding="' + xmlEncoding + '"?>' + newline
		+ '<!DOCTYPE nzb PUBLIC "-//newzBin//DTD NZB 1.1//EN" "http://www.newzbin.com/DTD/nzb/nzb-1.1.dtd">' + newline
		+ '<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">' + newline + data);
	
	this.indent = indent;
	this.newline = newline;
	this.segNum = null;
	
	this._fileEnd = this.indent + this.indent + '</segments>' + this.newline
	              + this.indent + '</file>' + this.newline;
}
NZBGenerator.prototype = {
	_closeFile: function() {
		return this.segNum !== null ? this._fileEnd : '';
	},
	file: function(subject, poster, groups, date) {
		this.write(this._closeFile() + this._fileXml(subject, poster, groups, date));
		this.segNum = 0;
	},
	wholeFile: function(subject, poster, groups, date, segments) {
		var data = this._closeFile() + this._fileXml(subject, poster, groups, date);
		// forEach skips over sparse arrays, so use regular for
		for(var i=0; i<segments.length; i++) {
			if(segments[i])
				data += this._segmentXml(i+1, segments[i][0], segments[i][1]);
		}
		
		this.write(data + this._fileEnd);
		this.segNum = null;
	},
	_fileXml: function(subject, poster, groups, date) {
		date = date || Date.now();
		
		var indent = this.indent, newline = this.newline;
		// the official spec [http://wiki.sabnzbd.org/nzb-specs] double-escapes the poster, which is probably a mistake on their end
		return indent + '<file poster="' + xmlEscape(poster) + '" date="' + Math.floor(date/1000) + '" subject="' + xmlEscape(subject) + '">' + newline
			+ indent + indent + '<groups>' + newline
			+ groups.map(function(g) {
				return indent+indent+indent + '<group>' + xmlEscape(g) + '</group>' + newline;
			}).join('')
			+ indent + indent + '</groups>' + newline
			+ indent + indent + '<segments>' + newline;
	},
	addSegment: function(size, messageId) {
		this.segNum++;
		this.write(this._segmentXml(this.segNum, size, messageId));
	},
	_segmentXml: function(segNum, size, messageId) {
		return this.indent+this.indent+this.indent + '<segment bytes="'+size+'" number="'+segNum+'">' + xmlEscape(messageId) + '</segment>' + this.newline;
	},
	end: function() {
		this.write(this._closeFile() + '</nzb>' + this.newline);
	},
	write: function(str) {
		this._write(str, this.encoding);
	}
};

module.exports = NZBGenerator;
