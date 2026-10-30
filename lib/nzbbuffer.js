"use strict";

var objIsEmpty = function(o) {
	for(var k in o) return false;
	return true;
};

// wrapper around NZBGenerator which allows out of order NZB generation
var NZBGenerator = require('./nzb');

function NZBBuffered(meta, writeFunc, packed, encoding, encrypted) {
	this.nzb = new NZBGenerator(meta, writeFunc, packed, encoding, encrypted);
	this.active = {};
}
NZBBuffered.prototype = {
	active: null, // currently active files
	fileCnt: 0, // for generating IDs
	numFiles: null, // if set, will auto-close the NZB when this number of files has finished
	file: function(subject, poster, groups, numSegments, date) {
		this.active[++this.fileCnt] = new NZBFile(this, subject, poster, groups, numSegments, date);
		this.active[this.fileCnt].fileId = this.fileCnt;
		return this.active[this.fileCnt];
	},
	_fileDone: function(file) {
		delete this.active[file.fileId];
		if(this.fileCnt === this.numFiles && objIsEmpty(this.active)) {
			this.nzb.end();
			this.active = null; // prevent double-close from caller
		}
	},
	end: function(forceFlush) {
		this.numFiles = null; // prevent the following from triggering a double-close with code above
		if(!this.active) return;
		if(forceFlush) {
			// flush out all files
			for(var k in this.active) {
				this.active[k]._flush();
			}
		}
		if(!objIsEmpty(this.active))
			throw new Error('Unfinished files exist');
		this.nzb.end();
	}
};

function NZBFile(parent, subject, poster, groups, numSegments, date) {
	this.parent = parent;
	this.subject = subject;
	this.poster = poster;
	this.groups = groups;
	this.date = date;
	
	this.segments = Array(numSegments);
	this.segCount = 0;
}
NZBFile.prototype = {
	// if messageId is invalid, will skip writing the segment
	set: function(idx, size, messageId) {
		if(!this.segments) throw new Error('Already finished');
		
		var numSeg = this.segments.length;
		if(idx >= numSeg || idx < 0) throw new Error('Invalid segment index supplied');
		
		if(!this.segments[idx]) this.segCount++;
		this.segments[idx] = messageId ? [size, messageId] : null;
		
		if(this.segCount == numSeg) {
			// have all segments, write it out
			this._flush();
		}
	},
	_flush: function() {
		this.parent.nzb.wholeFile(this.subject, this.poster, this.groups, this.date, this.segments);
		this.segments = null;
		this.parent._fileDone(this);
	},
	// skip writing a segment
	skip: function(idx) {
		this.set(idx, 0, null);
	}
};

module.exports = NZBBuffered;
