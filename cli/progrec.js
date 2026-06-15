"use strict";

module.exports = function(size, maxNum) {
	this.samples = [];
	this.size = size | 0;
	this.maxNum = maxNum;
};

module.exports.prototype = {
	add: function(num) {
		this.samples.push(num);
		var len = this.samples.length;
		if(len > this.size
		|| (this.maxNum && len > 2 && this.samples[len-1] - this.samples[1] >= this.maxNum))
			this.samples.shift();
	},
	count: function() {
		return this.samples.length;
	},
	// find the index of the last sample which satisfies the search criteria
	find: function(minSamples, minNum) {
		var len = this.samples.length;
		if(!len) return -1;
		if(len <= minSamples)
			return 0;
		
		var i = len - minSamples - 1;
		if(minNum === null || minNum === undefined)
			return i;
		var last = this.samples[len-1];
		while(1) {
			if(last - this.samples[i] >= minNum)
				return i;
			if(i-- < 1) return 0;
		}
	},
	_avg_diff: function(avg, minSamples, minNum) {
		if(minSamples < 1) throw new Error('minSamples must be > 0');
		var len = this.samples.length;
		if(len < 2) return null;
		var i = this.find(minSamples, minNum);
		var diff = this.samples[len-1] - this.samples[i];
		if(avg)
			return diff / (len - i - 1);
		return diff;
	},
	average: function(minSamples, minNum) {
		return this._avg_diff(true, minSamples, minNum);
	},
	diff: function(minSamples, minNum) {
		return this._avg_diff(false, minSamples, minNum);
	}
};

