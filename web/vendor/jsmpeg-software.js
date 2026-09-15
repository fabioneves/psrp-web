/*! JSMpeg | (c) Dominic Szablewski | MIT; see JSMpeg-LICENSE */
var JSMpeg = {
  Decoder: {}, Renderer: {}, Demuxer: {}, Source: {},
  Now: function() { return performance.now() / 1000; },
  Fill: function(array, value) { array.fill(value); }
};
JSMpeg.BitBuffer = (function(){ "use strict";

var BitBuffer = function(bufferOrLength, mode) {
	if (typeof(bufferOrLength) === 'object') {
		this.bytes = (bufferOrLength instanceof Uint8Array)
			? bufferOrLength 
			: new Uint8Array(bufferOrLength);

		this.byteLength = this.bytes.length;
	}
	else {
		this.bytes = new Uint8Array(bufferOrLength || 1024*1024);	
		this.byteLength = 0;
	}

	this.mode = mode || BitBuffer.MODE.EXPAND;
	this.index = 0;
};

BitBuffer.prototype.resize = function(size) {
	var newBytes = new Uint8Array(size);
	if (this.byteLength !== 0) {
		this.byteLength = Math.min(this.byteLength, size);
		newBytes.set(this.bytes, 0, this.byteLength);
	}
	this.bytes = newBytes;
	this.index = Math.min(this.index, this.byteLength << 3);
};

BitBuffer.prototype.evict = function(sizeNeeded) {
	var bytePos = this.index >> 3,
		available = this.bytes.length - this.byteLength;
	
	// If the current index is the write position, we can simply reset both
	// to 0. Also reset (and throw away yet unread data) if we won't be able
	// to fit the new data in even after a normal eviction.
	if (
		this.index === this.byteLength << 3 ||
		sizeNeeded > available + bytePos // emergency evac
	) {
		this.byteLength = 0;
		this.index = 0;
		return;
	}
	else if (bytePos === 0) {
		// Nothing read yet - we can't evict anything
		return;
	}
	
	// Some browsers don't support copyWithin() yet - we may have to do 
	// it manually using set and a subarray
	if (this.bytes.copyWithin) {
		this.bytes.copyWithin(0, bytePos, this.byteLength);
	}
	else {
		this.bytes.set(this.bytes.subarray(bytePos, this.byteLength));
	}

	this.byteLength = this.byteLength - bytePos;
	this.index -= bytePos << 3;
	return;
};

BitBuffer.prototype.write = function(buffers) {
	var isArrayOfBuffers = (typeof(buffers[0]) === 'object'),
		totalLength = 0,
		available = this.bytes.length - this.byteLength;

	// Calculate total byte length
	if (isArrayOfBuffers) {
		var totalLength = 0;
		for (var i = 0; i < buffers.length; i++) {
			totalLength += buffers[i].byteLength;
		}
	}
	else {
		totalLength = buffers.byteLength;
	}

	// Do we need to resize or evict?
	if (totalLength > available) {
		if (this.mode === BitBuffer.MODE.EXPAND) {
			var newSize = Math.max(
				this.bytes.length * 2,
				totalLength - available
			);
			this.resize(newSize)
		}
		else {
			this.evict(totalLength);
		}
	}

	if (isArrayOfBuffers) {
		for (var i = 0; i < buffers.length; i++) {
			this.appendSingleBuffer(buffers[i]);
		}
	}
	else {
		this.appendSingleBuffer(buffers);
	}

	return totalLength;
};

BitBuffer.prototype.appendSingleBuffer = function(buffer) {
	buffer = buffer instanceof Uint8Array
		? buffer 
		: new Uint8Array(buffer);
	
	this.bytes.set(buffer, this.byteLength);
	this.byteLength += buffer.length;
};

BitBuffer.prototype.findNextStartCode = function() {	
	for (var i = (this.index+7 >> 3); i < this.byteLength; i++) {
		if(
			this.bytes[i] == 0x00 &&
			this.bytes[i+1] == 0x00 &&
			this.bytes[i+2] == 0x01
		) {
			this.index = (i+4) << 3;
			return this.bytes[i+3];
		}
	}
	this.index = (this.byteLength << 3);
	return -1;
};

BitBuffer.prototype.findStartCode = function(code) {
	var current = 0;
	while (true) {
		current = this.findNextStartCode();
		if (current === code || current === -1) {
			return current;
		}
	}
	return -1;
};

BitBuffer.prototype.nextBytesAreStartCode = function() {
	var i = (this.index+7 >> 3);
	return (
		i >= this.byteLength || (
			this.bytes[i] == 0x00 && 
			this.bytes[i+1] == 0x00 &&
			this.bytes[i+2] == 0x01
		)
	);
};

BitBuffer.prototype.peek = function(count) {
	var offset = this.index;
	var value = 0;
	while (count) {
		var currentByte = this.bytes[offset >> 3],
			remaining = 8 - (offset & 7), // remaining bits in byte
			read = remaining < count ? remaining : count, // bits in this run
			shift = remaining - read,
			mask = (0xff >> (8-read));

		value = (value << read) | ((currentByte & (mask << shift)) >> shift);

		offset += read;
		count -= read;
	}

	return value;
}

BitBuffer.prototype.read = function(count) {
	var value = this.peek(count);
	this.index += count;
	return value;
};

BitBuffer.prototype.skip = function(count) {
	return (this.index += count);
};

BitBuffer.prototype.rewind = function(count) {
	this.index = Math.max(this.index - count, 0);
};

BitBuffer.prototype.has = function(count) {
	return ((this.byteLength << 3) - this.index) >= count;
};

BitBuffer.MODE = {
	EVICT: 1,
	EXPAND: 2
};

return BitBuffer;

})();



JSMpeg.Demuxer.TS = (function(){ "use strict";

var TS = function(options) {
	this.bits = null;
	this.leftoverBytes = null;

	this.guessVideoFrameEnd = true;
	this.pidsToStreamIds = {};

	this.pesPacketInfo = {};
	this.startTime = 0;
	this.currentTime = 0;
};

TS.prototype.connect = function(streamId, destination) {
	this.pesPacketInfo[streamId] = {
		destination: destination,
		currentLength: 0,
		totalLength: 0,
		pts: 0,
		buffers: []
	};
};

TS.prototype.write = function(buffer) {
	if (this.leftoverBytes) {
		var totalLength = buffer.byteLength + this.leftoverBytes.byteLength;
		this.bits = new JSMpeg.BitBuffer(totalLength);
		this.bits.write([this.leftoverBytes, buffer]);
	}
	else {
		this.bits = new JSMpeg.BitBuffer(buffer);
	}

	while (this.bits.has(188 << 3) && this.parsePacket()) {}

	var leftoverCount = this.bits.byteLength - (this.bits.index >> 3);
	this.leftoverBytes = leftoverCount > 0
		? this.bits.bytes.subarray(this.bits.index >> 3)
		: null;
};

TS.prototype.parsePacket = function() {
	// Check if we're in sync with packet boundaries; attempt to resync if not.
	if (this.bits.read(8) !== 0x47) {
		if (!this.resync()) {
			// Couldn't resync; maybe next time...
			return false;
		}
	}

	var end = (this.bits.index >> 3) + 187;
	var transportError = this.bits.read(1),
		payloadStart = this.bits.read(1),
		transportPriority = this.bits.read(1),
		pid = this.bits.read(13),
		transportScrambling = this.bits.read(2),
		adaptationField = this.bits.read(2),
		continuityCounter = this.bits.read(4);


	// If this is the start of a new payload; signal the end of the previous
	// frame, if we didn't do so already.
	var streamId = this.pidsToStreamIds[pid];
	if (payloadStart && streamId) {
		var pi = this.pesPacketInfo[streamId];
		if (pi && pi.currentLength) {
			this.packetComplete(pi);
		}
	}

	// Extract current payload
	if (adaptationField & 0x1) {
		if ((adaptationField & 0x2)) {
			var adaptationFieldLength = this.bits.read(8);
			this.bits.skip(adaptationFieldLength << 3);
		}

		if (payloadStart && this.bits.nextBytesAreStartCode()) {
			this.bits.skip(24);
			streamId = this.bits.read(8);
			this.pidsToStreamIds[pid] = streamId;

			var packetLength = this.bits.read(16)
			this.bits.skip(8);
			var ptsDtsFlag = this.bits.read(2);
			this.bits.skip(6);
			var headerLength = this.bits.read(8);
			var payloadBeginIndex = this.bits.index + (headerLength << 3);
			
			var pi = this.pesPacketInfo[streamId];
			if (pi) {
				var pts = 0;
				if (ptsDtsFlag & 0x2) {
					// The Presentation Timestamp is encoded as 33(!) bit
					// integer, but has a "marker bit" inserted at weird places
					// in between, making the whole thing 5 bytes in size.
					// You can't make this shit up...
					this.bits.skip(4);
					var p32_30 = this.bits.read(3);
					this.bits.skip(1);
					var p29_15 = this.bits.read(15);
					this.bits.skip(1);
					var p14_0 = this.bits.read(15);
					this.bits.skip(1);

					// Can't use bit shifts here; we need 33 bits of precision,
					// so we're using JavaScript's double number type. Also
					// divide by the 90khz clock to get the pts in seconds.
					pts = (p32_30 * 1073741824 + p29_15 * 32768 + p14_0)/90000;
					
					this.currentTime = pts;
					if (this.startTime === -1) {
						this.startTime = pts;
					}
				}

				var payloadLength = packetLength 
					? packetLength - headerLength - 3
					: 0;
				this.packetStart(pi, pts, payloadLength);
			}

			// Skip the rest of the header without parsing it
			this.bits.index = payloadBeginIndex;
		}

		if (streamId) {
			// Attempt to detect if the PES packet is complete. For Audio (and
			// other) packets, we received a total packet length with the PES 
			// header, so we can check the current length.

			// For Video packets, we have to guess the end by detecting if this
			// TS packet was padded - there's no good reason to pad a TS packet 
			// in between, but it might just fit exactly. If this fails, we can
			// only wait for the next PES header for that stream.

			var pi = this.pesPacketInfo[streamId];
			if (pi) {
				var start = this.bits.index >> 3;
				var complete = this.packetAddData(pi, start, end);

				var hasPadding = !payloadStart && (adaptationField & 0x2);
				if (complete || (this.guessVideoFrameEnd && hasPadding)) {
					this.packetComplete(pi);	
				}
			}
		}
	}

	this.bits.index = end << 3;
	return true;
};

TS.prototype.resync = function() {
	// Check if we have enough data to attempt a resync. We need 5 full packets.
	if (!this.bits.has((188 * 6) << 3)) {
		return false;
	}

	var byteIndex = this.bits.index >> 3;

	// Look for the first sync token in the first 187 bytes
	for (var i = 0; i < 187; i++) {
		if (this.bits.bytes[byteIndex + i] === 0x47) {

			// Look for 4 more sync tokens, each 188 bytes appart
			var foundSync = true;
			for (var j = 1; j < 5; j++) {
				if (this.bits.bytes[byteIndex + i + 188 * j] !== 0x47) {
					foundSync = false;
					break;
				}
			}

			if (foundSync) {
				this.bits.index = (byteIndex + i + 1) << 3;
				return true;
			}
		}
	}

	// In theory, we shouldn't arrive here. If we do, we had enough data but
	// still didn't find sync - this can only happen if we were fed garbage
	// data. Check your source!
	console.warn('JSMpeg: Possible garbage data. Skipping.');
	this.bits.skip(187 << 3);
	return false;
};

TS.prototype.packetStart = function(pi, pts, payloadLength) {
	pi.totalLength = payloadLength;
	pi.currentLength = 0;
	pi.pts = pts;
};

TS.prototype.packetAddData = function(pi, start, end) {
	pi.buffers.push(this.bits.bytes.subarray(start, end));
	pi.currentLength += end - start;

	var complete = (pi.totalLength !== 0 && pi.currentLength >= pi.totalLength);
	return complete;
};

TS.prototype.packetComplete = function(pi) {
	pi.destination.write(pi.pts, pi.buffers);
	pi.totalLength = 0;
	pi.currentLength = 0;
	pi.buffers = [];
};

TS.STREAM = {
	PACK_HEADER: 0xBA,
	SYSTEM_HEADER: 0xBB,
	PROGRAM_MAP: 0xBC,
	PRIVATE_1: 0xBD,
	PADDING: 0xBE,
	PRIVATE_2: 0xBF,
	AUDIO_1: 0xC0,
	VIDEO_1: 0xE0,
	DIRECTORY: 0xFF
};

return TS;

})();



JSMpeg.Decoder.Base = (function(){ "use strict";

var BaseDecoder = function(options) {
	this.destination = null;
	this.canPlay = false;

	this.collectTimestamps = !options.streaming;
	this.bytesWritten = 0;
	this.timestamps = [];
	this.timestampIndex = 0;

	this.startTime = 0;
	this.decodedTime = 0;

	Object.defineProperty(this, 'currentTime', {get: this.getCurrentTime});
};

BaseDecoder.prototype.destroy = function() {};

BaseDecoder.prototype.connect = function(destination) {
	this.destination = destination;
};

BaseDecoder.prototype.bufferGetIndex = function() {
	return this.bits.index;
};

BaseDecoder.prototype.bufferSetIndex = function(index) {
	this.bits.index = index;
};

BaseDecoder.prototype.bufferWrite = function(buffers) {
	return this.bits.write(buffers);
};

BaseDecoder.prototype.write = function(pts, buffers) {
	if (this.collectTimestamps) {
		if (this.timestamps.length === 0) {
			this.startTime = pts;
			this.decodedTime = pts;
		}
		this.timestamps.push({index: this.bytesWritten << 3, time: pts});
	}

	this.bytesWritten += this.bufferWrite(buffers);
	this.canPlay = true;
};

BaseDecoder.prototype.seek = function(time) {
	if (!this.collectTimestamps) {
		return;
	}

	this.timestampIndex = 0;
	for (var i = 0; i < this.timestamps.length; i++) {
		if (this.timestamps[i].time > time) {
			break;
		}
		this.timestampIndex = i;
	}

	var ts = this.timestamps[this.timestampIndex];
	if (ts) {
		this.bufferSetIndex(ts.index);
		this.decodedTime = ts.time;
	}
	else {
		this.bufferSetIndex(0);
		this.decodedTime = this.startTime;
	}
};

BaseDecoder.prototype.decode = function() {
	this.advanceDecodedTime(0);
};

BaseDecoder.prototype.advanceDecodedTime = function(seconds) {
	if (this.collectTimestamps) {
		var newTimestampIndex = -1;
		var currentIndex = this.bufferGetIndex();
		for (var i = this.timestampIndex; i < this.timestamps.length; i++) {
			if (this.timestamps[i].index > currentIndex) {
				break;
			}
			newTimestampIndex = i;
		}

		// Did we find a new PTS, different from the last? If so, we don't have
		// to advance the decoded time manually and can instead sync it exactly
		// to the PTS.
		if (
			newTimestampIndex !== -1 && 
			newTimestampIndex !== this.timestampIndex
		) {
			this.timestampIndex = newTimestampIndex;
			this.decodedTime = this.timestamps[this.timestampIndex].time;
			return;
		}
	}

	this.decodedTime += seconds;
};

BaseDecoder.prototype.getCurrentTime = function() {
	return this.decodedTime;
};

return BaseDecoder;

})();



JSMpeg.Decoder.MPEG1Video = (function(){ "use strict";

// Inspired by Java MPEG-1 Video Decoder and Player by Zoltan Korandi 
// https://sourceforge.net/projects/javampeg1video/

var MPEG1 = function(options) {
	JSMpeg.Decoder.Base.call(this, options);

	this.onDecodeCallback = options.onVideoDecode;

	var bufferSize = options.videoBufferSize || 512*1024;
	var bufferMode = options.streaming
		? JSMpeg.BitBuffer.MODE.EVICT
		: JSMpeg.BitBuffer.MODE.EXPAND;

	this.bits = new JSMpeg.BitBuffer(bufferSize, bufferMode);

	this.customIntraQuantMatrix = new Uint8Array(64);
	this.customNonIntraQuantMatrix = new Uint8Array(64);
	this.blockData = new Int32Array(64);

	this.currentFrame = 0;
	this.decodeFirstFrame = options.decodeFirstFrame !== false;
};

MPEG1.prototype = Object.create(JSMpeg.Decoder.Base.prototype);
MPEG1.prototype.constructor = MPEG1;

MPEG1.prototype.write = function(pts, buffers) {
	JSMpeg.Decoder.Base.prototype.write.call(this, pts, buffers);

	if (!this.hasSequenceHeader) {
		if (this.bits.findStartCode(MPEG1.START.SEQUENCE) === -1) {
			return false;
		}
		this.decodeSequenceHeader();

		if (this.decodeFirstFrame) {
			this.decode();
		}
	}
};

MPEG1.prototype.decode = function() {
	var startTime = JSMpeg.Now();
	
	if (!this.hasSequenceHeader) {
		return false;
	}

	if (this.bits.findStartCode(MPEG1.START.PICTURE) === -1) {
		var bufferedBytes = this.bits.byteLength - (this.bits.index >> 3);
		return false;
	}

	this.decodePicture();
	this.advanceDecodedTime(1/this.frameRate);

	var elapsedTime = JSMpeg.Now() - startTime;
	if (this.onDecodeCallback) {
		this.onDecodeCallback(this, elapsedTime);
	}
	return true;
};

MPEG1.prototype.readHuffman = function(codeTable) {
	var state = 0;
	do {
		state = codeTable[state + this.bits.read(1)];
	} while (state >= 0 && codeTable[state] !== 0);
	return codeTable[state+2];
};


// Sequence Layer

MPEG1.prototype.frameRate = 30;
MPEG1.prototype.decodeSequenceHeader = function() {
	var newWidth = this.bits.read(12),
		newHeight = this.bits.read(12);

	// skip pixel aspect ratio
	this.bits.skip(4);

	this.frameRate = MPEG1.PICTURE_RATE[this.bits.read(4)];

	// skip bitRate, marker, bufferSize and constrained bit
	this.bits.skip(18 + 1 + 10 + 1);

	if (newWidth !== this.width || newHeight !== this.height) {
		this.width = newWidth;
		this.height = newHeight;

		this.initBuffers();

		if (this.destination) {
			this.destination.resize(newWidth, newHeight);
		}
	}

	if (this.bits.read(1)) { // load custom intra quant matrix?
		for (var i = 0; i < 64; i++) {
			this.customIntraQuantMatrix[MPEG1.ZIG_ZAG[i]] = this.bits.read(8);
		}
		this.intraQuantMatrix = this.customIntraQuantMatrix;
	}

	if (this.bits.read(1)) { // load custom non intra quant matrix?
		for (var i = 0; i < 64; i++) {
			var idx = MPEG1.ZIG_ZAG[i];
			this.customNonIntraQuantMatrix[idx] = this.bits.read(8);
		}
		this.nonIntraQuantMatrix = this.customNonIntraQuantMatrix;
	}

	this.hasSequenceHeader = true;
};

MPEG1.prototype.initBuffers = function() {
	this.intraQuantMatrix = MPEG1.DEFAULT_INTRA_QUANT_MATRIX;
	this.nonIntraQuantMatrix = MPEG1.DEFAULT_NON_INTRA_QUANT_MATRIX;

	this.mbWidth = (this.width + 15) >> 4;
	this.mbHeight = (this.height + 15) >> 4;
	this.mbSize = this.mbWidth * this.mbHeight;

	this.codedWidth = this.mbWidth << 4;
	this.codedHeight = this.mbHeight << 4;
	this.codedSize = this.codedWidth * this.codedHeight;

	this.halfWidth = this.mbWidth << 3;
	this.halfHeight = this.mbHeight << 3;

	// Allocated buffers and resize the canvas
	this.currentY = new Uint8ClampedArray(this.codedSize);
	this.currentY32 = new Uint32Array(this.currentY.buffer);

	this.currentCr = new Uint8ClampedArray(this.codedSize >> 2);
	this.currentCr32 = new Uint32Array(this.currentCr.buffer);

	this.currentCb = new Uint8ClampedArray(this.codedSize >> 2);
	this.currentCb32 = new Uint32Array(this.currentCb.buffer);


	this.forwardY = new Uint8ClampedArray(this.codedSize);
	this.forwardY32 = new Uint32Array(this.forwardY.buffer);

	this.forwardCr = new Uint8ClampedArray(this.codedSize >> 2);
	this.forwardCr32 = new Uint32Array(this.forwardCr.buffer);

	this.forwardCb = new Uint8ClampedArray(this.codedSize >> 2);
	this.forwardCb32 = new Uint32Array(this.forwardCb.buffer);
};


// Picture Layer

MPEG1.prototype.currentY = null;
MPEG1.prototype.currentCr = null;
MPEG1.prototype.currentCb = null;

MPEG1.prototype.pictureType = 0;

// Buffers for motion compensation
MPEG1.prototype.forwardY = null;
MPEG1.prototype.forwardCr = null;
MPEG1.prototype.forwardCb = null;

MPEG1.prototype.fullPelForward = false;
MPEG1.prototype.forwardFCode = 0;
MPEG1.prototype.forwardRSize = 0;
MPEG1.prototype.forwardF = 0;

MPEG1.prototype.decodePicture = function(skipOutput) {
	this.currentFrame++;

	this.bits.skip(10); // skip temporalReference
	this.pictureType = this.bits.read(3);
	this.bits.skip(16); // skip vbv_delay

	// Skip B and D frames or unknown coding type
	if (this.pictureType <= 0 || this.pictureType >= MPEG1.PICTURE_TYPE.B) {
		return;
	}

	// full_pel_forward, forward_f_code
	if (this.pictureType === MPEG1.PICTURE_TYPE.PREDICTIVE) {
		this.fullPelForward = this.bits.read(1);
		this.forwardFCode = this.bits.read(3);
		if (this.forwardFCode === 0) {
			// Ignore picture with zero forward_f_code
			return;
		}
		this.forwardRSize = this.forwardFCode - 1;
		this.forwardF = 1 << this.forwardRSize;
	}

	var code = 0;
	do {
		code = this.bits.findNextStartCode();
	} while (code === MPEG1.START.EXTENSION || code === MPEG1.START.USER_DATA );


	while (code >= MPEG1.START.SLICE_FIRST && code <= MPEG1.START.SLICE_LAST) {
		this.decodeSlice(code & 0x000000FF);
		code = this.bits.findNextStartCode();
	}

	if (code !== -1) {
		// We found the next start code; rewind 32bits and let the main loop
		// handle it.
		this.bits.rewind(32);
	}

	// Invoke decode callbacks
	if (this.destination) {
		this.destination.render(this.currentY, this.currentCr, this.currentCb, true);
	}

	// If this is a reference picutre then rotate the prediction pointers
	if (
		this.pictureType === MPEG1.PICTURE_TYPE.INTRA ||
		this.pictureType === MPEG1.PICTURE_TYPE.PREDICTIVE
	) {
		var
			tmpY = this.forwardY,
			tmpY32 = this.forwardY32,
			tmpCr = this.forwardCr,
			tmpCr32 = this.forwardCr32,
			tmpCb = this.forwardCb,
			tmpCb32 = this.forwardCb32;

		this.forwardY = this.currentY;
		this.forwardY32 = this.currentY32;
		this.forwardCr = this.currentCr;
		this.forwardCr32 = this.currentCr32;
		this.forwardCb = this.currentCb;
		this.forwardCb32 = this.currentCb32;

		this.currentY = tmpY;
		this.currentY32 = tmpY32;
		this.currentCr = tmpCr;
		this.currentCr32 = tmpCr32;
		this.currentCb = tmpCb;
		this.currentCb32 = tmpCb32;
	}
};


// Slice Layer

MPEG1.prototype.quantizerScale = 0;
MPEG1.prototype.sliceBegin = false;

MPEG1.prototype.decodeSlice = function(slice) {
	this.sliceBegin = true;
	this.macroblockAddress = (slice - 1) * this.mbWidth - 1;

	// Reset motion vectors and DC predictors
	this.motionFwH = this.motionFwHPrev = 0;
	this.motionFwV = this.motionFwVPrev = 0;
	this.dcPredictorY  = 128;
	this.dcPredictorCr = 128;
	this.dcPredictorCb = 128;

	this.quantizerScale = this.bits.read(5);

	// skip extra bits
	while (this.bits.read(1)) {
		this.bits.skip(8);
	}

	do {
		this.decodeMacroblock();
	} while (!this.bits.nextBytesAreStartCode());
};


// Macroblock Layer

MPEG1.prototype.macroblockAddress = 0;
MPEG1.prototype.mbRow = 0;
MPEG1.prototype.mbCol = 0;

MPEG1.prototype.macroblockType = 0;
MPEG1.prototype.macroblockIntra = false;
MPEG1.prototype.macroblockMotFw = false;

MPEG1.prototype.motionFwH = 0;
MPEG1.prototype.motionFwV = 0;
MPEG1.prototype.motionFwHPrev = 0;
MPEG1.prototype.motionFwVPrev = 0;

MPEG1.prototype.decodeMacroblock = function() {
	// Decode macroblock_address_increment
	var
		increment = 0,
		t = this.readHuffman(MPEG1.MACROBLOCK_ADDRESS_INCREMENT);

	while (t === 34) {
		// macroblock_stuffing
		t = this.readHuffman(MPEG1.MACROBLOCK_ADDRESS_INCREMENT);
	}
	while (t === 35) {
		// macroblock_escape
		increment += 33;
		t = this.readHuffman(MPEG1.MACROBLOCK_ADDRESS_INCREMENT);
	}
	increment += t;

	// Process any skipped macroblocks
	if (this.sliceBegin) {
		// The first macroblock_address_increment of each slice is relative
		// to beginning of the preverious row, not the preverious macroblock
		this.sliceBegin = false;
		this.macroblockAddress += increment;
	}
	else {
		if (this.macroblockAddress + increment >= this.mbSize) {
			// Illegal (too large) macroblock_address_increment
			return;
		}
		if (increment > 1) {
			// Skipped macroblocks reset DC predictors
			this.dcPredictorY  = 128;
			this.dcPredictorCr = 128;
			this.dcPredictorCb = 128;

			// Skipped macroblocks in P-pictures reset motion vectors
			if (this.pictureType === MPEG1.PICTURE_TYPE.PREDICTIVE) {
				this.motionFwH = this.motionFwHPrev = 0;
				this.motionFwV = this.motionFwVPrev = 0;
			}
		}

		// Predict skipped macroblocks
		while (increment > 1) {
			this.macroblockAddress++;
			this.mbRow = (this.macroblockAddress / this.mbWidth)|0;
			this.mbCol = this.macroblockAddress % this.mbWidth;
			this.copyMacroblock(
				this.motionFwH, this.motionFwV,
				this.forwardY, this.forwardCr, this.forwardCb
			);
			increment--;
		}
		this.macroblockAddress++;
	}
	this.mbRow = (this.macroblockAddress / this.mbWidth)|0;
	this.mbCol = this.macroblockAddress % this.mbWidth;

	// Process the current macroblock
	var mbTable = MPEG1.MACROBLOCK_TYPE[this.pictureType];
	this.macroblockType = this.readHuffman(mbTable);
	this.macroblockIntra = (this.macroblockType & 0x01);
	this.macroblockMotFw = (this.macroblockType & 0x08);

	// Quantizer scale
	if ((this.macroblockType & 0x10) !== 0) {
		this.quantizerScale = this.bits.read(5);
	}

	if (this.macroblockIntra) {
		// Intra-coded macroblocks reset motion vectors
		this.motionFwH = this.motionFwHPrev = 0;
		this.motionFwV = this.motionFwVPrev = 0;
	}
	else {
		// Non-intra macroblocks reset DC predictors
		this.dcPredictorY = 128;
		this.dcPredictorCr = 128;
		this.dcPredictorCb = 128;

		this.decodeMotionVectors();
		this.copyMacroblock(
			this.motionFwH, this.motionFwV,
			this.forwardY, this.forwardCr, this.forwardCb
		);
	}

	// Decode blocks
	var cbp = ((this.macroblockType & 0x02) !== 0)
		? this.readHuffman(MPEG1.CODE_BLOCK_PATTERN)
		: (this.macroblockIntra ? 0x3f : 0);

	for (var block = 0, mask = 0x20; block < 6; block++) {
		if ((cbp & mask) !== 0) {
			this.decodeBlock(block);
		}
		mask >>= 1;
	}
};


MPEG1.prototype.decodeMotionVectors = function() {
	var code, d, r = 0;

	// Forward
	if (this.macroblockMotFw) {
		// Horizontal forward
		code = this.readHuffman(MPEG1.MOTION);
		if ((code !== 0) && (this.forwardF !== 1)) {
			r = this.bits.read(this.forwardRSize);
			d = ((Math.abs(code) - 1) << this.forwardRSize) + r + 1;
			if (code < 0) {
				d = -d;
			}
		}
		else {
			d = code;
		}

		this.motionFwHPrev += d;
		if (this.motionFwHPrev > (this.forwardF << 4) - 1) {
			this.motionFwHPrev -= this.forwardF << 5;
		}
		else if (this.motionFwHPrev < ((-this.forwardF) << 4)) {
			this.motionFwHPrev += this.forwardF << 5;
		}

		this.motionFwH = this.motionFwHPrev;
		if (this.fullPelForward) {
			this.motionFwH <<= 1;
		}

		// Vertical forward
		code = this.readHuffman(MPEG1.MOTION);
		if ((code !== 0) && (this.forwardF !== 1)) {
			r = this.bits.read(this.forwardRSize);
			d = ((Math.abs(code) - 1) << this.forwardRSize) + r + 1;
			if (code < 0) {
				d = -d;
			}
		}
		else {
			d = code;
		}

		this.motionFwVPrev += d;
		if (this.motionFwVPrev > (this.forwardF << 4) - 1) {
			this.motionFwVPrev -= this.forwardF << 5;
		}
		else if (this.motionFwVPrev < ((-this.forwardF) << 4)) {
			this.motionFwVPrev += this.forwardF << 5;
		}

		this.motionFwV = this.motionFwVPrev;
		if (this.fullPelForward) {
			this.motionFwV <<= 1;
		}
	}
	else if (this.pictureType === MPEG1.PICTURE_TYPE.PREDICTIVE) {
		// No motion information in P-picture, reset vectors
		this.motionFwH = this.motionFwHPrev = 0;
		this.motionFwV = this.motionFwVPrev = 0;
	}
};

MPEG1.prototype.copyMacroblock = function(motionH, motionV, sY, sCr, sCb) {
	var
		width, scan,
		H, V, oddH, oddV,
		src, dest, last;

	// We use 32bit writes here
	var dY = this.currentY32,
		dCb = this.currentCb32,
		dCr = this.currentCr32;

	// Luminance
	width = this.codedWidth;
	scan = width - 16;

	H = motionH >> 1;
	V = motionV >> 1;
	oddH = (motionH & 1) === 1;
	oddV = (motionV & 1) === 1;

	src = ((this.mbRow << 4) + V) * width + (this.mbCol << 4) + H;
	dest = (this.mbRow * width + this.mbCol) << 2;
	last = dest + (width << 2);

	var x, y1, y2, y;
	if (oddH) {
		if (oddV) {
			while (dest < last) {
				y1 = sY[src] + sY[src+width]; src++;
				for (x = 0; x < 4; x++) {
					y2 = sY[src] + sY[src+width]; src++;
					y = (((y1 + y2 + 2) >> 2) & 0xff);

					y1 = sY[src] + sY[src+width]; src++;
					y |= (((y1 + y2 + 2) << 6) & 0xff00);

					y2 = sY[src] + sY[src+width]; src++;
					y |= (((y1 + y2 + 2) << 14) & 0xff0000);

					y1 = sY[src] + sY[src+width]; src++;
					y |= (((y1 + y2 + 2) << 22) & 0xff000000);

					dY[dest++] = y;
				}
				dest += scan >> 2; src += scan-1;
			}
		}
		else {
			while (dest < last) {
				y1 = sY[src++];
				for (x = 0; x < 4; x++) {
					y2 = sY[src++];
					y = (((y1 + y2 + 1) >> 1) & 0xff);

					y1 = sY[src++];
					y |= (((y1 + y2 + 1) << 7) & 0xff00);

					y2 = sY[src++];
					y |= (((y1 + y2 + 1) << 15) & 0xff0000);

					y1 = sY[src++];
					y |= (((y1 + y2 + 1) << 23) & 0xff000000);

					dY[dest++] = y;
				}
				dest += scan >> 2; src += scan-1;
			}
		}
	}
	else {
		if (oddV) {
			while (dest < last) {
				for (x = 0; x < 4; x++) {
					y = (((sY[src] + sY[src+width] + 1) >> 1) & 0xff); src++;
					y |= (((sY[src] + sY[src+width] + 1) << 7) & 0xff00); src++;
					y |= (((sY[src] + sY[src+width] + 1) << 15) & 0xff0000); src++;
					y |= (((sY[src] + sY[src+width] + 1) << 23) & 0xff000000); src++;

					dY[dest++] = y;
				}
				dest += scan >> 2; src += scan;
			}
		}
		else {
			while (dest < last) {
				for (x = 0; x < 4; x++) {
					y = sY[src]; src++;
					y |= sY[src] << 8; src++;
					y |= sY[src] << 16; src++;
					y |= sY[src] << 24; src++;

					dY[dest++] = y;
				}
				dest += scan >> 2; src += scan;
			}
		}
	}

	// Chrominance

	width = this.halfWidth;
	scan = width - 8;

	H = (motionH/2) >> 1;
	V = (motionV/2) >> 1;
	oddH = ((motionH/2) & 1) === 1;
	oddV = ((motionV/2) & 1) === 1;

	src = ((this.mbRow << 3) + V) * width + (this.mbCol << 3) + H;
	dest = (this.mbRow * width + this.mbCol) << 1;
	last = dest + (width << 1);

	var cr1, cr2, cr,
		cb1, cb2, cb;
	if (oddH) {
		if (oddV) {
			while (dest < last) {
				cr1 = sCr[src] + sCr[src+width];
				cb1 = sCb[src] + sCb[src+width];
				src++;
				for (x = 0; x < 2; x++) {
					cr2 = sCr[src] + sCr[src+width];
					cb2 = sCb[src] + sCb[src+width]; src++;
					cr = (((cr1 + cr2 + 2) >> 2) & 0xff);
					cb = (((cb1 + cb2 + 2) >> 2) & 0xff);

					cr1 = sCr[src] + sCr[src+width];
					cb1 = sCb[src] + sCb[src+width]; src++;
					cr |= (((cr1 + cr2 + 2) << 6) & 0xff00);
					cb |= (((cb1 + cb2 + 2) << 6) & 0xff00);

					cr2 = sCr[src] + sCr[src+width];
					cb2 = sCb[src] + sCb[src+width]; src++;
					cr |= (((cr1 + cr2 + 2) << 14) & 0xff0000);
					cb |= (((cb1 + cb2 + 2) << 14) & 0xff0000);

					cr1 = sCr[src] + sCr[src+width];
					cb1 = sCb[src] + sCb[src+width]; src++;
					cr |= (((cr1 + cr2 + 2) << 22) & 0xff000000);
					cb |= (((cb1 + cb2 + 2) << 22) & 0xff000000);

					dCr[dest] = cr;
					dCb[dest] = cb;
					dest++;
				}
				dest += scan >> 2; src += scan-1;
			}
		}
		else {
			while (dest < last) {
				cr1 = sCr[src];
				cb1 = sCb[src];
				src++;
				for (x = 0; x < 2; x++) {
					cr2 = sCr[src];
					cb2 = sCb[src++];
					cr = (((cr1 + cr2 + 1) >> 1) & 0xff);
					cb = (((cb1 + cb2 + 1) >> 1) & 0xff);

					cr1 = sCr[src];
					cb1 = sCb[src++];
					cr |= (((cr1 + cr2 + 1) << 7) & 0xff00);
					cb |= (((cb1 + cb2 + 1) << 7) & 0xff00);

					cr2 = sCr[src];
					cb2 = sCb[src++];
					cr |= (((cr1 + cr2 + 1) << 15) & 0xff0000);
					cb |= (((cb1 + cb2 + 1) << 15) & 0xff0000);

					cr1 = sCr[src];
					cb1 = sCb[src++];
					cr |= (((cr1 + cr2 + 1) << 23) & 0xff000000);
					cb |= (((cb1 + cb2 + 1) << 23) & 0xff000000);

					dCr[dest] = cr;
					dCb[dest] = cb;
					dest++;
				}
				dest += scan >> 2; src += scan-1;
			}
		}
	}
	else {
		if (oddV) {
			while (dest < last) {
				for (x = 0; x < 2; x++) {
					cr = (((sCr[src] + sCr[src+width] + 1) >> 1) & 0xff);
					cb = (((sCb[src] + sCb[src+width] + 1) >> 1) & 0xff); src++;

					cr |= (((sCr[src] + sCr[src+width] + 1) << 7) & 0xff00);
					cb |= (((sCb[src] + sCb[src+width] + 1) << 7) & 0xff00); src++;

					cr |= (((sCr[src] + sCr[src+width] + 1) << 15) & 0xff0000);
					cb |= (((sCb[src] + sCb[src+width] + 1) << 15) & 0xff0000); src++;

					cr |= (((sCr[src] + sCr[src+width] + 1) << 23) & 0xff000000);
					cb |= (((sCb[src] + sCb[src+width] + 1) << 23) & 0xff000000); src++;

					dCr[dest] = cr;
					dCb[dest] = cb;
					dest++;
				}
				dest += scan >> 2; src += scan;
			}
		}
		else {
			while (dest < last) {
				for (x = 0; x < 2; x++) {
					cr = sCr[src];
					cb = sCb[src]; src++;

					cr |= sCr[src] << 8;
					cb |= sCb[src] << 8; src++;

					cr |= sCr[src] << 16;
					cb |= sCb[src] << 16; src++;

					cr |= sCr[src] << 24;
					cb |= sCb[src] << 24; src++;

					dCr[dest] = cr;
					dCb[dest] = cb;
					dest++;
				}
				dest += scan >> 2; src += scan;
			}
		}
	}
};


// Block layer

MPEG1.prototype.dcPredictorY = 0;
MPEG1.prototype.dcPredictorCr = 0;
MPEG1.prototype.dcPredictorCb = 0;

MPEG1.prototype.blockData = null;

MPEG1.prototype.decodeBlock = function(block) {

	var
		n = 0,
		quantMatrix;

	// Decode DC coefficient of intra-coded blocks
	if (this.macroblockIntra) {
		var
			predictor,
			dctSize;

		// DC prediction

		if (block < 4) {
			predictor = this.dcPredictorY;
			dctSize = this.readHuffman(MPEG1.DCT_DC_SIZE_LUMINANCE);
		}
		else {
			predictor = (block === 4 ? this.dcPredictorCr : this.dcPredictorCb);
			dctSize = this.readHuffman(MPEG1.DCT_DC_SIZE_CHROMINANCE);
		}

		// Read DC coeff
		if (dctSize > 0) {
			var differential = this.bits.read(dctSize);
			if ((differential & (1 << (dctSize - 1))) !== 0) {
				this.blockData[0] = predictor + differential;
			}
			else {
				this.blockData[0] = predictor + ((-1 << dctSize)|(differential+1));
			}
		}
		else {
			this.blockData[0] = predictor;
		}

		// Save predictor value
		if (block < 4) {
			this.dcPredictorY = this.blockData[0];
		}
		else if (block === 4) {
			this.dcPredictorCr = this.blockData[0];
		}
		else {
			this.dcPredictorCb = this.blockData[0];
		}

		// Dequantize + premultiply
		this.blockData[0] <<= (3 + 5);

		quantMatrix = this.intraQuantMatrix;
		n = 1;
	}
	else {
		quantMatrix = this.nonIntraQuantMatrix;
	}

	// Decode AC coefficients (+DC for non-intra)
	var level = 0;
	while (true) {
		var
			run = 0,
			coeff = this.readHuffman(MPEG1.DCT_COEFF);

		if ((coeff === 0x0001) && (n > 0) && (this.bits.read(1) === 0)) {
			// end_of_block
			break;
		}
		if (coeff === 0xffff) {
			// escape
			run = this.bits.read(6);
			level = this.bits.read(8);
			if (level === 0) {
				level = this.bits.read(8);
			}
			else if (level === 128) {
				level = this.bits.read(8) - 256;
			}
			else if (level > 128) {
				level = level - 256;
			}
		}
		else {
			run = coeff >> 8;
			level = coeff & 0xff;
			if (this.bits.read(1)) {
				level = -level;
			}
		}

		n += run;
		var dezigZagged = MPEG1.ZIG_ZAG[n];
		n++;

		// Dequantize, oddify, clip
		level <<= 1;
		if (!this.macroblockIntra) {
			level += (level < 0 ? -1 : 1);
		}
		level = (level * this.quantizerScale * quantMatrix[dezigZagged]) >> 4;
		if ((level & 1) === 0) {
			level -= level > 0 ? 1 : -1;
		}
		if (level > 2047) {
			level = 2047;
		}
		else if (level < -2048) {
			level = -2048;
		}

		// Save premultiplied coefficient
		this.blockData[dezigZagged] = level * MPEG1.PREMULTIPLIER_MATRIX[dezigZagged];
	}

	// Move block to its place
	var
		destArray,
		destIndex,
		scan;

	if (block < 4) {
		destArray = this.currentY;
		scan = this.codedWidth - 8;
		destIndex = (this.mbRow * this.codedWidth + this.mbCol) << 4;
		if ((block & 1) !== 0) {
			destIndex += 8;
		}
		if ((block & 2) !== 0) {
			destIndex += this.codedWidth << 3;
		}
	}
	else {
		destArray = (block === 4) ? this.currentCb : this.currentCr;
		scan = (this.codedWidth >> 1) - 8;
		destIndex = ((this.mbRow * this.codedWidth) << 2) + (this.mbCol << 3);
	}

	if (this.macroblockIntra) {
		// Overwrite (no prediction)
		if (n === 1) {
			MPEG1.CopyValueToDestination((this.blockData[0] + 128) >> 8, destArray, destIndex, scan);
			this.blockData[0] = 0;
		}
		else {
			MPEG1.IDCT(this.blockData);
			MPEG1.CopyBlockToDestination(this.blockData, destArray, destIndex, scan);
			JSMpeg.Fill(this.blockData, 0);
		}
	}
	else {
		// Add data to the predicted macroblock
		if (n === 1) {
			MPEG1.AddValueToDestination((this.blockData[0] + 128) >> 8, destArray, destIndex, scan);
			this.blockData[0] = 0;
		}
		else {
			MPEG1.IDCT(this.blockData);
			MPEG1.AddBlockToDestination(this.blockData, destArray, destIndex, scan);
			JSMpeg.Fill(this.blockData, 0);
		}
	}

	n = 0;
};

MPEG1.CopyBlockToDestination = function(block, dest, index, scan) {
	for (var n = 0; n < 64; n += 8, index += scan+8) {
		dest[index+0] = block[n+0];
		dest[index+1] = block[n+1];
		dest[index+2] = block[n+2];
		dest[index+3] = block[n+3];
		dest[index+4] = block[n+4];
		dest[index+5] = block[n+5];
		dest[index+6] = block[n+6];
		dest[index+7] = block[n+7];
	}
};

MPEG1.AddBlockToDestination = function(block, dest, index, scan) {
	for (var n = 0; n < 64; n += 8, index += scan+8) {
		dest[index+0] += block[n+0];
		dest[index+1] += block[n+1];
		dest[index+2] += block[n+2];
		dest[index+3] += block[n+3];
		dest[index+4] += block[n+4];
		dest[index+5] += block[n+5];
		dest[index+6] += block[n+6];
		dest[index+7] += block[n+7];
	}
};

MPEG1.CopyValueToDestination = function(value, dest, index, scan) {
	for (var n = 0; n < 64; n += 8, index += scan+8) {
		dest[index+0] = value;
		dest[index+1] = value;
		dest[index+2] = value;
		dest[index+3] = value;
		dest[index+4] = value;
		dest[index+5] = value;
		dest[index+6] = value;
		dest[index+7] = value;
	}
};

MPEG1.AddValueToDestination = function(value, dest, index, scan) {
	for (var n = 0; n < 64; n += 8, index += scan+8) {
		dest[index+0] += value;
		dest[index+1] += value;
		dest[index+2] += value;
		dest[index+3] += value;
		dest[index+4] += value;
		dest[index+5] += value;
		dest[index+6] += value;
		dest[index+7] += value;
	}
};

MPEG1.IDCT = function(block) {
	// See http://vsr.informatik.tu-chemnitz.de/~jan/MPEG/HTML/IDCT.html
	// for more info.

	var
		b1, b3, b4, b6, b7, tmp1, tmp2, m0,
		x0, x1, x2, x3, x4, y3, y4, y5, y6, y7;

	// Transform columns
	for (var i = 0; i < 8; ++i) {
		b1 = block[4*8+i];
		b3 = block[2*8+i] + block[6*8+i];
		b4 = block[5*8+i] - block[3*8+i];
		tmp1 = block[1*8+i] + block[7*8+i];
		tmp2 = block[3*8+i] + block[5*8+i];
		b6 = block[1*8+i] - block[7*8+i];
		b7 = tmp1 + tmp2;
		m0 = block[0*8+i];
		x4 = ((b6*473 - b4*196 + 128) >> 8) - b7;
		x0 = x4 - (((tmp1 - tmp2)*362 + 128) >> 8);
		x1 = m0 - b1;
		x2 = (((block[2*8+i] - block[6*8+i])*362 + 128) >> 8) - b3;
		x3 = m0 + b1;
		y3 = x1 + x2;
		y4 = x3 + b3;
		y5 = x1 - x2;
		y6 = x3 - b3;
		y7 = -x0 - ((b4*473 + b6*196 + 128) >> 8);
		block[0*8+i] = b7 + y4;
		block[1*8+i] = x4 + y3;
		block[2*8+i] = y5 - x0;
		block[3*8+i] = y6 - y7;
		block[4*8+i] = y6 + y7;
		block[5*8+i] = x0 + y5;
		block[6*8+i] = y3 - x4;
		block[7*8+i] = y4 - b7;
	}

	// Transform rows
	for (var i = 0; i < 64; i += 8) {
		b1 = block[4+i];
		b3 = block[2+i] + block[6+i];
		b4 = block[5+i] - block[3+i];
		tmp1 = block[1+i] + block[7+i];
		tmp2 = block[3+i] + block[5+i];
		b6 = block[1+i] - block[7+i];
		b7 = tmp1 + tmp2;
		m0 = block[0+i];
		x4 = ((b6*473 - b4*196 + 128) >> 8) - b7;
		x0 = x4 - (((tmp1 - tmp2)*362 + 128) >> 8);
		x1 = m0 - b1;
		x2 = (((block[2+i] - block[6+i])*362 + 128) >> 8) - b3;
		x3 = m0 + b1;
		y3 = x1 + x2;
		y4 = x3 + b3;
		y5 = x1 - x2;
		y6 = x3 - b3;
		y7 = -x0 - ((b4*473 + b6*196 + 128) >> 8);
		block[0+i] = (b7 + y4 + 128) >> 8;
		block[1+i] = (x4 + y3 + 128) >> 8;
		block[2+i] = (y5 - x0 + 128) >> 8;
		block[3+i] = (y6 - y7 + 128) >> 8;
		block[4+i] = (y6 + y7 + 128) >> 8;
		block[5+i] = (x0 + y5 + 128) >> 8;
		block[6+i] = (y3 - x4 + 128) >> 8;
		block[7+i] = (y4 - b7 + 128) >> 8;
	}
};


// VLC Tables and Constants

MPEG1.PICTURE_RATE = [
	0.000, 23.976, 24.000, 25.000, 29.970, 30.000, 50.000, 59.940,
	60.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000
];

MPEG1.ZIG_ZAG = new Uint8Array([
	 0,  1,  8, 16,  9,  2,  3, 10,
	17, 24, 32, 25, 18, 11,  4,  5,
	12, 19, 26, 33, 40, 48, 41, 34,
	27, 20, 13,  6,  7, 14, 21, 28,
	35, 42, 49, 56, 57, 50, 43, 36,
	29, 22, 15, 23, 30, 37, 44, 51,
	58, 59, 52, 45, 38, 31, 39, 46,
	53, 60, 61, 54, 47, 55, 62, 63
]);

MPEG1.DEFAULT_INTRA_QUANT_MATRIX = new Uint8Array([
	 8, 16, 19, 22, 26, 27, 29, 34,
	16, 16, 22, 24, 27, 29, 34, 37,
	19, 22, 26, 27, 29, 34, 34, 38,
	22, 22, 26, 27, 29, 34, 37, 40,
	22, 26, 27, 29, 32, 35, 40, 48,
	26, 27, 29, 32, 35, 40, 48, 58,
	26, 27, 29, 34, 38, 46, 56, 69,
	27, 29, 35, 38, 46, 56, 69, 83
]);

MPEG1.DEFAULT_NON_INTRA_QUANT_MATRIX = new Uint8Array([
	16, 16, 16, 16, 16, 16, 16, 16,
	16, 16, 16, 16, 16, 16, 16, 16,
	16, 16, 16, 16, 16, 16, 16, 16,
	16, 16, 16, 16, 16, 16, 16, 16,
	16, 16, 16, 16, 16, 16, 16, 16,
	16, 16, 16, 16, 16, 16, 16, 16,
	16, 16, 16, 16, 16, 16, 16, 16,
	16, 16, 16, 16, 16, 16, 16, 16
]);

MPEG1.PREMULTIPLIER_MATRIX = new Uint8Array([
	32, 44, 42, 38, 32, 25, 17,  9,
	44, 62, 58, 52, 44, 35, 24, 12,
	42, 58, 55, 49, 42, 33, 23, 12,
	38, 52, 49, 44, 38, 30, 20, 10,
	32, 44, 42, 38, 32, 25, 17,  9,
	25, 35, 33, 30, 25, 20, 14,  7,
	17, 24, 23, 20, 17, 14,  9,  5,
	 9, 12, 12, 10,  9,  7,  5,  2
]);

// MPEG-1 VLC

//  macroblock_stuffing decodes as 34.
//  macroblock_escape decodes as 35.

MPEG1.MACROBLOCK_ADDRESS_INCREMENT = new Int16Array([
	 1*3,  2*3,  0, //   0
	 3*3,  4*3,  0, //   1  0
	   0,    0,  1, //   2  1.
	 5*3,  6*3,  0, //   3  00
	 7*3,  8*3,  0, //   4  01
	 9*3, 10*3,  0, //   5  000
	11*3, 12*3,  0, //   6  001
	   0,    0,  3, //   7  010.
	   0,    0,  2, //   8  011.
	13*3, 14*3,  0, //   9  0000
	15*3, 16*3,  0, //  10  0001
	   0,    0,  5, //  11  0010.
	   0,    0,  4, //  12  0011.
	17*3, 18*3,  0, //  13  0000 0
	19*3, 20*3,  0, //  14  0000 1
	   0,    0,  7, //  15  0001 0.
	   0,    0,  6, //  16  0001 1.
	21*3, 22*3,  0, //  17  0000 00
	23*3, 24*3,  0, //  18  0000 01
	25*3, 26*3,  0, //  19  0000 10
	27*3, 28*3,  0, //  20  0000 11
	  -1, 29*3,  0, //  21  0000 000
	  -1, 30*3,  0, //  22  0000 001
	31*3, 32*3,  0, //  23  0000 010
	33*3, 34*3,  0, //  24  0000 011
	35*3, 36*3,  0, //  25  0000 100
	37*3, 38*3,  0, //  26  0000 101
	   0,    0,  9, //  27  0000 110.
	   0,    0,  8, //  28  0000 111.
	39*3, 40*3,  0, //  29  0000 0001
	41*3, 42*3,  0, //  30  0000 0011
	43*3, 44*3,  0, //  31  0000 0100
	45*3, 46*3,  0, //  32  0000 0101
	   0,    0, 15, //  33  0000 0110.
	   0,    0, 14, //  34  0000 0111.
	   0,    0, 13, //  35  0000 1000.
	   0,    0, 12, //  36  0000 1001.
	   0,    0, 11, //  37  0000 1010.
	   0,    0, 10, //  38  0000 1011.
	47*3,   -1,  0, //  39  0000 0001 0
	  -1, 48*3,  0, //  40  0000 0001 1
	49*3, 50*3,  0, //  41  0000 0011 0
	51*3, 52*3,  0, //  42  0000 0011 1
	53*3, 54*3,  0, //  43  0000 0100 0
	55*3, 56*3,  0, //  44  0000 0100 1
	57*3, 58*3,  0, //  45  0000 0101 0
	59*3, 60*3,  0, //  46  0000 0101 1
	61*3,   -1,  0, //  47  0000 0001 00
	  -1, 62*3,  0, //  48  0000 0001 11
	63*3, 64*3,  0, //  49  0000 0011 00
	65*3, 66*3,  0, //  50  0000 0011 01
	67*3, 68*3,  0, //  51  0000 0011 10
	69*3, 70*3,  0, //  52  0000 0011 11
	71*3, 72*3,  0, //  53  0000 0100 00
	73*3, 74*3,  0, //  54  0000 0100 01
	   0,    0, 21, //  55  0000 0100 10.
	   0,    0, 20, //  56  0000 0100 11.
	   0,    0, 19, //  57  0000 0101 00.
	   0,    0, 18, //  58  0000 0101 01.
	   0,    0, 17, //  59  0000 0101 10.
	   0,    0, 16, //  60  0000 0101 11.
	   0,    0, 35, //  61  0000 0001 000. -- macroblock_escape
	   0,    0, 34, //  62  0000 0001 111. -- macroblock_stuffing
	   0,    0, 33, //  63  0000 0011 000.
	   0,    0, 32, //  64  0000 0011 001.
	   0,    0, 31, //  65  0000 0011 010.
	   0,    0, 30, //  66  0000 0011 011.
	   0,    0, 29, //  67  0000 0011 100.
	   0,    0, 28, //  68  0000 0011 101.
	   0,    0, 27, //  69  0000 0011 110.
	   0,    0, 26, //  70  0000 0011 111.
	   0,    0, 25, //  71  0000 0100 000.
	   0,    0, 24, //  72  0000 0100 001.
	   0,    0, 23, //  73  0000 0100 010.
	   0,    0, 22  //  74  0000 0100 011.
]);

//  macroblock_type bitmap:
//    0x10  macroblock_quant
//    0x08  macroblock_motion_forward
//    0x04  macroblock_motion_backward
//    0x02  macrobkock_pattern
//    0x01  macroblock_intra
//

MPEG1.MACROBLOCK_TYPE_INTRA = new Int8Array([
	 1*3,  2*3,     0, //   0
	  -1,  3*3,     0, //   1  0
	   0,    0,  0x01, //   2  1.
	   0,    0,  0x11  //   3  01.
]);

MPEG1.MACROBLOCK_TYPE_PREDICTIVE = new Int8Array([
	 1*3,  2*3,     0, //  0
	 3*3,  4*3,     0, //  1  0
	   0,    0,  0x0a, //  2  1.
	 5*3,  6*3,     0, //  3  00
	   0,    0,  0x02, //  4  01.
	 7*3,  8*3,     0, //  5  000
	   0,    0,  0x08, //  6  001.
	 9*3, 10*3,     0, //  7  0000
	11*3, 12*3,     0, //  8  0001
	  -1, 13*3,     0, //  9  00000
	   0,    0,  0x12, // 10  00001.
	   0,    0,  0x1a, // 11  00010.
	   0,    0,  0x01, // 12  00011.
	   0,    0,  0x11  // 13  000001.
]);

MPEG1.MACROBLOCK_TYPE_B = new Int8Array([
	 1*3,  2*3,     0,  //  0
	 3*3,  5*3,     0,  //  1  0
	 4*3,  6*3,     0,  //  2  1
	 8*3,  7*3,     0,  //  3  00
	   0,    0,  0x0c,  //  4  10.
	 9*3, 10*3,     0,  //  5  01
	   0,    0,  0x0e,  //  6  11.
	13*3, 14*3,     0,  //  7  001
	12*3, 11*3,     0,  //  8  000
	   0,    0,  0x04,  //  9  010.
	   0,    0,  0x06,  // 10  011.
	18*3, 16*3,     0,  // 11  0001
	15*3, 17*3,     0,  // 12  0000
	   0,    0,  0x08,  // 13  0010.
	   0,    0,  0x0a,  // 14  0011.
	  -1, 19*3,     0,  // 15  00000
	   0,    0,  0x01,  // 16  00011.
	20*3, 21*3,     0,  // 17  00001
	   0,    0,  0x1e,  // 18  00010.
	   0,    0,  0x11,  // 19  000001.
	   0,    0,  0x16,  // 20  000010.
	   0,    0,  0x1a   // 21  000011.
]);

MPEG1.MACROBLOCK_TYPE = [
	null,
	MPEG1.MACROBLOCK_TYPE_INTRA,
	MPEG1.MACROBLOCK_TYPE_PREDICTIVE,
	MPEG1.MACROBLOCK_TYPE_B
];

MPEG1.CODE_BLOCK_PATTERN = new Int16Array([
	  2*3,   1*3,   0,  //   0
	  3*3,   6*3,   0,  //   1  1
	  4*3,   5*3,   0,  //   2  0
	  8*3,  11*3,   0,  //   3  10
	 12*3,  13*3,   0,  //   4  00
	  9*3,   7*3,   0,  //   5  01
	 10*3,  14*3,   0,  //   6  11
	 20*3,  19*3,   0,  //   7  011
	 18*3,  16*3,   0,  //   8  100
	 23*3,  17*3,   0,  //   9  010
	 27*3,  25*3,   0,  //  10  110
	 21*3,  28*3,   0,  //  11  101
	 15*3,  22*3,   0,  //  12  000
	 24*3,  26*3,   0,  //  13  001
	    0,     0,  60,  //  14  111.
	 35*3,  40*3,   0,  //  15  0000
	 44*3,  48*3,   0,  //  16  1001
	 38*3,  36*3,   0,  //  17  0101
	 42*3,  47*3,   0,  //  18  1000
	 29*3,  31*3,   0,  //  19  0111
	 39*3,  32*3,   0,  //  20  0110
	    0,     0,  32,  //  21  1010.
	 45*3,  46*3,   0,  //  22  0001
	 33*3,  41*3,   0,  //  23  0100
	 43*3,  34*3,   0,  //  24  0010
	    0,     0,   4,  //  25  1101.
	 30*3,  37*3,   0,  //  26  0011
	    0,     0,   8,  //  27  1100.
	    0,     0,  16,  //  28  1011.
	    0,     0,  44,  //  29  0111 0.
	 50*3,  56*3,   0,  //  30  0011 0
	    0,     0,  28,  //  31  0111 1.
	    0,     0,  52,  //  32  0110 1.
	    0,     0,  62,  //  33  0100 0.
	 61*3,  59*3,   0,  //  34  0010 1
	 52*3,  60*3,   0,  //  35  0000 0
	    0,     0,   1,  //  36  0101 1.
	 55*3,  54*3,   0,  //  37  0011 1
	    0,     0,  61,  //  38  0101 0.
	    0,     0,  56,  //  39  0110 0.
	 57*3,  58*3,   0,  //  40  0000 1
	    0,     0,   2,  //  41  0100 1.
	    0,     0,  40,  //  42  1000 0.
	 51*3,  62*3,   0,  //  43  0010 0
	    0,     0,  48,  //  44  1001 0.
	 64*3,  63*3,   0,  //  45  0001 0
	 49*3,  53*3,   0,  //  46  0001 1
	    0,     0,  20,  //  47  1000 1.
	    0,     0,  12,  //  48  1001 1.
	 80*3,  83*3,   0,  //  49  0001 10
	    0,     0,  63,  //  50  0011 00.
	 77*3,  75*3,   0,  //  51  0010 00
	 65*3,  73*3,   0,  //  52  0000 00
	 84*3,  66*3,   0,  //  53  0001 11
	    0,     0,  24,  //  54  0011 11.
	    0,     0,  36,  //  55  0011 10.
	    0,     0,   3,  //  56  0011 01.
	 69*3,  87*3,   0,  //  57  0000 10
	 81*3,  79*3,   0,  //  58  0000 11
	 68*3,  71*3,   0,  //  59  0010 11
	 70*3,  78*3,   0,  //  60  0000 01
	 67*3,  76*3,   0,  //  61  0010 10
	 72*3,  74*3,   0,  //  62  0010 01
	 86*3,  85*3,   0,  //  63  0001 01
	 88*3,  82*3,   0,  //  64  0001 00
	   -1,  94*3,   0,  //  65  0000 000
	 95*3,  97*3,   0,  //  66  0001 111
	    0,     0,  33,  //  67  0010 100.
	    0,     0,   9,  //  68  0010 110.
	106*3, 110*3,   0,  //  69  0000 100
	102*3, 116*3,   0,  //  70  0000 010
	    0,     0,   5,  //  71  0010 111.
	    0,     0,  10,  //  72  0010 010.
	 93*3,  89*3,   0,  //  73  0000 001
	    0,     0,   6,  //  74  0010 011.
	    0,     0,  18,  //  75  0010 001.
	    0,     0,  17,  //  76  0010 101.
	    0,     0,  34,  //  77  0010 000.
	113*3, 119*3,   0,  //  78  0000 011
	103*3, 104*3,   0,  //  79  0000 111
	 90*3,  92*3,   0,  //  80  0001 100
	109*3, 107*3,   0,  //  81  0000 110
	117*3, 118*3,   0,  //  82  0001 001
	101*3,  99*3,   0,  //  83  0001 101
	 98*3,  96*3,   0,  //  84  0001 110
	100*3,  91*3,   0,  //  85  0001 011
	114*3, 115*3,   0,  //  86  0001 010
	105*3, 108*3,   0,  //  87  0000 101
	112*3, 111*3,   0,  //  88  0001 000
	121*3, 125*3,   0,  //  89  0000 0011
	    0,     0,  41,  //  90  0001 1000.
	    0,     0,  14,  //  91  0001 0111.
	    0,     0,  21,  //  92  0001 1001.
	124*3, 122*3,   0,  //  93  0000 0010
	120*3, 123*3,   0,  //  94  0000 0001
	    0,     0,  11,  //  95  0001 1110.
	    0,     0,  19,  //  96  0001 1101.
	    0,     0,   7,  //  97  0001 1111.
	    0,     0,  35,  //  98  0001 1100.
	    0,     0,  13,  //  99  0001 1011.
	    0,     0,  50,  // 100  0001 0110.
	    0,     0,  49,  // 101  0001 1010.
	    0,     0,  58,  // 102  0000 0100.
	    0,     0,  37,  // 103  0000 1110.
	    0,     0,  25,  // 104  0000 1111.
	    0,     0,  45,  // 105  0000 1010.
	    0,     0,  57,  // 106  0000 1000.
	    0,     0,  26,  // 107  0000 1101.
	    0,     0,  29,  // 108  0000 1011.
	    0,     0,  38,  // 109  0000 1100.
	    0,     0,  53,  // 110  0000 1001.
	    0,     0,  23,  // 111  0001 0001.
	    0,     0,  43,  // 112  0001 0000.
	    0,     0,  46,  // 113  0000 0110.
	    0,     0,  42,  // 114  0001 0100.
	    0,     0,  22,  // 115  0001 0101.
	    0,     0,  54,  // 116  0000 0101.
	    0,     0,  51,  // 117  0001 0010.
	    0,     0,  15,  // 118  0001 0011.
	    0,     0,  30,  // 119  0000 0111.
	    0,     0,  39,  // 120  0000 0001 0.
	    0,     0,  47,  // 121  0000 0011 0.
	    0,     0,  55,  // 122  0000 0010 1.
	    0,     0,  27,  // 123  0000 0001 1.
	    0,     0,  59,  // 124  0000 0010 0.
	    0,     0,  31   // 125  0000 0011 1.
]);

MPEG1.MOTION = new Int16Array([
	  1*3,   2*3,   0,  //   0
	  4*3,   3*3,   0,  //   1  0
	    0,     0,   0,  //   2  1.
	  6*3,   5*3,   0,  //   3  01
	  8*3,   7*3,   0,  //   4  00
	    0,     0,  -1,  //   5  011.
	    0,     0,   1,  //   6  010.
	  9*3,  10*3,   0,  //   7  001
	 12*3,  11*3,   0,  //   8  000
	    0,     0,   2,  //   9  0010.
	    0,     0,  -2,  //  10  0011.
	 14*3,  15*3,   0,  //  11  0001
	 16*3,  13*3,   0,  //  12  0000
	 20*3,  18*3,   0,  //  13  0000 1
	    0,     0,   3,  //  14  0001 0.
	    0,     0,  -3,  //  15  0001 1.
	 17*3,  19*3,   0,  //  16  0000 0
	   -1,  23*3,   0,  //  17  0000 00
	 27*3,  25*3,   0,  //  18  0000 11
	 26*3,  21*3,   0,  //  19  0000 01
	 24*3,  22*3,   0,  //  20  0000 10
	 32*3,  28*3,   0,  //  21  0000 011
	 29*3,  31*3,   0,  //  22  0000 101
	   -1,  33*3,   0,  //  23  0000 001
	 36*3,  35*3,   0,  //  24  0000 100
	    0,     0,  -4,  //  25  0000 111.
	 30*3,  34*3,   0,  //  26  0000 010
	    0,     0,   4,  //  27  0000 110.
	    0,     0,  -7,  //  28  0000 0111.
	    0,     0,   5,  //  29  0000 1010.
	 37*3,  41*3,   0,  //  30  0000 0100
	    0,     0,  -5,  //  31  0000 1011.
	    0,     0,   7,  //  32  0000 0110.
	 38*3,  40*3,   0,  //  33  0000 0011
	 42*3,  39*3,   0,  //  34  0000 0101
	    0,     0,  -6,  //  35  0000 1001.
	    0,     0,   6,  //  36  0000 1000.
	 51*3,  54*3,   0,  //  37  0000 0100 0
	 50*3,  49*3,   0,  //  38  0000 0011 0
	 45*3,  46*3,   0,  //  39  0000 0101 1
	 52*3,  47*3,   0,  //  40  0000 0011 1
	 43*3,  53*3,   0,  //  41  0000 0100 1
	 44*3,  48*3,   0,  //  42  0000 0101 0
	    0,     0,  10,  //  43  0000 0100 10.
	    0,     0,   9,  //  44  0000 0101 00.
	    0,     0,   8,  //  45  0000 0101 10.
	    0,     0,  -8,  //  46  0000 0101 11.
	 57*3,  66*3,   0,  //  47  0000 0011 11
	    0,     0,  -9,  //  48  0000 0101 01.
	 60*3,  64*3,   0,  //  49  0000 0011 01
	 56*3,  61*3,   0,  //  50  0000 0011 00
	 55*3,  62*3,   0,  //  51  0000 0100 00
	 58*3,  63*3,   0,  //  52  0000 0011 10
	    0,     0, -10,  //  53  0000 0100 11.
	 59*3,  65*3,   0,  //  54  0000 0100 01
	    0,     0,  12,  //  55  0000 0100 000.
	    0,     0,  16,  //  56  0000 0011 000.
	    0,     0,  13,  //  57  0000 0011 110.
	    0,     0,  14,  //  58  0000 0011 100.
	    0,     0,  11,  //  59  0000 0100 010.
	    0,     0,  15,  //  60  0000 0011 010.
	    0,     0, -16,  //  61  0000 0011 001.
	    0,     0, -12,  //  62  0000 0100 001.
	    0,     0, -14,  //  63  0000 0011 101.
	    0,     0, -15,  //  64  0000 0011 011.
	    0,     0, -11,  //  65  0000 0100 011.
	    0,     0, -13   //  66  0000 0011 111.
]);

MPEG1.DCT_DC_SIZE_LUMINANCE = new Int8Array([
	  2*3,   1*3, 0,  //   0
	  6*3,   5*3, 0,  //   1  1
	  3*3,   4*3, 0,  //   2  0
	    0,     0, 1,  //   3  00.
	    0,     0, 2,  //   4  01.
	  9*3,   8*3, 0,  //   5  11
	  7*3,  10*3, 0,  //   6  10
	    0,     0, 0,  //   7  100.
	 12*3,  11*3, 0,  //   8  111
	    0,     0, 4,  //   9  110.
	    0,     0, 3,  //  10  101.
	 13*3,  14*3, 0,  //  11  1111
	    0,     0, 5,  //  12  1110.
	    0,     0, 6,  //  13  1111 0.
	 16*3,  15*3, 0,  //  14  1111 1
	 17*3,    -1, 0,  //  15  1111 11
	    0,     0, 7,  //  16  1111 10.
	    0,     0, 8   //  17  1111 110.
]);

MPEG1.DCT_DC_SIZE_CHROMINANCE = new Int8Array([
	  2*3,   1*3, 0,  //   0
	  4*3,   3*3, 0,  //   1  1
	  6*3,   5*3, 0,  //   2  0
	  8*3,   7*3, 0,  //   3  11
	    0,     0, 2,  //   4  10.
	    0,     0, 1,  //   5  01.
	    0,     0, 0,  //   6  00.
	 10*3,   9*3, 0,  //   7  111
	    0,     0, 3,  //   8  110.
	 12*3,  11*3, 0,  //   9  1111
	    0,     0, 4,  //  10  1110.
	 14*3,  13*3, 0,  //  11  1111 1
	    0,     0, 5,  //  12  1111 0.
	 16*3,  15*3, 0,  //  13  1111 11
	    0,     0, 6,  //  14  1111 10.
	 17*3,    -1, 0,  //  15  1111 111
	    0,     0, 7,  //  16  1111 110.
	    0,     0, 8   //  17  1111 1110.
]);

//  dct_coeff bitmap:
//    0xff00  run
//    0x00ff  level

//  Decoded values are unsigned. Sign bit follows in the stream.

//  Interpretation of the value 0x0001
//    for dc_coeff_first:  run=0, level=1
//    for dc_coeff_next:   If the next bit is 1: run=0, level=1
//                         If the next bit is 0: end_of_block

//  escape decodes as 0xffff.

MPEG1.DCT_COEFF = new Int32Array([
	  1*3,   2*3,      0,  //   0
	  4*3,   3*3,      0,  //   1  0
	    0,     0, 0x0001,  //   2  1.
	  7*3,   8*3,      0,  //   3  01
	  6*3,   5*3,      0,  //   4  00
	 13*3,   9*3,      0,  //   5  001
	 11*3,  10*3,      0,  //   6  000
	 14*3,  12*3,      0,  //   7  010
	    0,     0, 0x0101,  //   8  011.
	 20*3,  22*3,      0,  //   9  0011
	 18*3,  21*3,      0,  //  10  0001
	 16*3,  19*3,      0,  //  11  0000
	    0,     0, 0x0201,  //  12  0101.
	 17*3,  15*3,      0,  //  13  0010
	    0,     0, 0x0002,  //  14  0100.
	    0,     0, 0x0003,  //  15  0010 1.
	 27*3,  25*3,      0,  //  16  0000 0
	 29*3,  31*3,      0,  //  17  0010 0
	 24*3,  26*3,      0,  //  18  0001 0
	 32*3,  30*3,      0,  //  19  0000 1
	    0,     0, 0x0401,  //  20  0011 0.
	 23*3,  28*3,      0,  //  21  0001 1
	    0,     0, 0x0301,  //  22  0011 1.
	    0,     0, 0x0102,  //  23  0001 10.
	    0,     0, 0x0701,  //  24  0001 00.
	    0,     0, 0xffff,  //  25  0000 01. -- escape
	    0,     0, 0x0601,  //  26  0001 01.
	 37*3,  36*3,      0,  //  27  0000 00
	    0,     0, 0x0501,  //  28  0001 11.
	 35*3,  34*3,      0,  //  29  0010 00
	 39*3,  38*3,      0,  //  30  0000 11
	 33*3,  42*3,      0,  //  31  0010 01
	 40*3,  41*3,      0,  //  32  0000 10
	 52*3,  50*3,      0,  //  33  0010 010
	 54*3,  53*3,      0,  //  34  0010 001
	 48*3,  49*3,      0,  //  35  0010 000
	 43*3,  45*3,      0,  //  36  0000 001
	 46*3,  44*3,      0,  //  37  0000 000
	    0,     0, 0x0801,  //  38  0000 111.
	    0,     0, 0x0004,  //  39  0000 110.
	    0,     0, 0x0202,  //  40  0000 100.
	    0,     0, 0x0901,  //  41  0000 101.
	 51*3,  47*3,      0,  //  42  0010 011
	 55*3,  57*3,      0,  //  43  0000 0010
	 60*3,  56*3,      0,  //  44  0000 0001
	 59*3,  58*3,      0,  //  45  0000 0011
	 61*3,  62*3,      0,  //  46  0000 0000
	    0,     0, 0x0a01,  //  47  0010 0111.
	    0,     0, 0x0d01,  //  48  0010 0000.
	    0,     0, 0x0006,  //  49  0010 0001.
	    0,     0, 0x0103,  //  50  0010 0101.
	    0,     0, 0x0005,  //  51  0010 0110.
	    0,     0, 0x0302,  //  52  0010 0100.
	    0,     0, 0x0b01,  //  53  0010 0011.
	    0,     0, 0x0c01,  //  54  0010 0010.
	 76*3,  75*3,      0,  //  55  0000 0010 0
	 67*3,  70*3,      0,  //  56  0000 0001 1
	 73*3,  71*3,      0,  //  57  0000 0010 1
	 78*3,  74*3,      0,  //  58  0000 0011 1
	 72*3,  77*3,      0,  //  59  0000 0011 0
	 69*3,  64*3,      0,  //  60  0000 0001 0
	 68*3,  63*3,      0,  //  61  0000 0000 0
	 66*3,  65*3,      0,  //  62  0000 0000 1
	 81*3,  87*3,      0,  //  63  0000 0000 01
	 91*3,  80*3,      0,  //  64  0000 0001 01
	 82*3,  79*3,      0,  //  65  0000 0000 11
	 83*3,  86*3,      0,  //  66  0000 0000 10
	 93*3,  92*3,      0,  //  67  0000 0001 10
	 84*3,  85*3,      0,  //  68  0000 0000 00
	 90*3,  94*3,      0,  //  69  0000 0001 00
	 88*3,  89*3,      0,  //  70  0000 0001 11
	    0,     0, 0x0203,  //  71  0000 0010 11.
	    0,     0, 0x0104,  //  72  0000 0011 00.
	    0,     0, 0x0007,  //  73  0000 0010 10.
	    0,     0, 0x0402,  //  74  0000 0011 11.
	    0,     0, 0x0502,  //  75  0000 0010 01.
	    0,     0, 0x1001,  //  76  0000 0010 00.
	    0,     0, 0x0f01,  //  77  0000 0011 01.
	    0,     0, 0x0e01,  //  78  0000 0011 10.
	105*3, 107*3,      0,  //  79  0000 0000 111
	111*3, 114*3,      0,  //  80  0000 0001 011
	104*3,  97*3,      0,  //  81  0000 0000 010
	125*3, 119*3,      0,  //  82  0000 0000 110
	 96*3,  98*3,      0,  //  83  0000 0000 100
	   -1, 123*3,      0,  //  84  0000 0000 000
	 95*3, 101*3,      0,  //  85  0000 0000 001
	106*3, 121*3,      0,  //  86  0000 0000 101
	 99*3, 102*3,      0,  //  87  0000 0000 011
	113*3, 103*3,      0,  //  88  0000 0001 110
	112*3, 116*3,      0,  //  89  0000 0001 111
	110*3, 100*3,      0,  //  90  0000 0001 000
	124*3, 115*3,      0,  //  91  0000 0001 010
	117*3, 122*3,      0,  //  92  0000 0001 101
	109*3, 118*3,      0,  //  93  0000 0001 100
	120*3, 108*3,      0,  //  94  0000 0001 001
	127*3, 136*3,      0,  //  95  0000 0000 0010
	139*3, 140*3,      0,  //  96  0000 0000 1000
	130*3, 126*3,      0,  //  97  0000 0000 0101
	145*3, 146*3,      0,  //  98  0000 0000 1001
	128*3, 129*3,      0,  //  99  0000 0000 0110
	    0,     0, 0x0802,  // 100  0000 0001 0001.
	132*3, 134*3,      0,  // 101  0000 0000 0011
	155*3, 154*3,      0,  // 102  0000 0000 0111
	    0,     0, 0x0008,  // 103  0000 0001 1101.
	137*3, 133*3,      0,  // 104  0000 0000 0100
	143*3, 144*3,      0,  // 105  0000 0000 1110
	151*3, 138*3,      0,  // 106  0000 0000 1010
	142*3, 141*3,      0,  // 107  0000 0000 1111
	    0,     0, 0x000a,  // 108  0000 0001 0011.
	    0,     0, 0x0009,  // 109  0000 0001 1000.
	    0,     0, 0x000b,  // 110  0000 0001 0000.
	    0,     0, 0x1501,  // 111  0000 0001 0110.
	    0,     0, 0x0602,  // 112  0000 0001 1110.
	    0,     0, 0x0303,  // 113  0000 0001 1100.
	    0,     0, 0x1401,  // 114  0000 0001 0111.
	    0,     0, 0x0702,  // 115  0000 0001 0101.
	    0,     0, 0x1101,  // 116  0000 0001 1111.
	    0,     0, 0x1201,  // 117  0000 0001 1010.
	    0,     0, 0x1301,  // 118  0000 0001 1001.
	148*3, 152*3,      0,  // 119  0000 0000 1101
	    0,     0, 0x0403,  // 120  0000 0001 0010.
	153*3, 150*3,      0,  // 121  0000 0000 1011
	    0,     0, 0x0105,  // 122  0000 0001 1011.
	131*3, 135*3,      0,  // 123  0000 0000 0001
	    0,     0, 0x0204,  // 124  0000 0001 0100.
	149*3, 147*3,      0,  // 125  0000 0000 1100
	172*3, 173*3,      0,  // 126  0000 0000 0101 1
	162*3, 158*3,      0,  // 127  0000 0000 0010 0
	170*3, 161*3,      0,  // 128  0000 0000 0110 0
	168*3, 166*3,      0,  // 129  0000 0000 0110 1
	157*3, 179*3,      0,  // 130  0000 0000 0101 0
	169*3, 167*3,      0,  // 131  0000 0000 0001 0
	174*3, 171*3,      0,  // 132  0000 0000 0011 0
	178*3, 177*3,      0,  // 133  0000 0000 0100 1
	156*3, 159*3,      0,  // 134  0000 0000 0011 1
	164*3, 165*3,      0,  // 135  0000 0000 0001 1
	183*3, 182*3,      0,  // 136  0000 0000 0010 1
	175*3, 176*3,      0,  // 137  0000 0000 0100 0
	    0,     0, 0x0107,  // 138  0000 0000 1010 1.
	    0,     0, 0x0a02,  // 139  0000 0000 1000 0.
	    0,     0, 0x0902,  // 140  0000 0000 1000 1.
	    0,     0, 0x1601,  // 141  0000 0000 1111 1.
	    0,     0, 0x1701,  // 142  0000 0000 1111 0.
	    0,     0, 0x1901,  // 143  0000 0000 1110 0.
	    0,     0, 0x1801,  // 144  0000 0000 1110 1.
	    0,     0, 0x0503,  // 145  0000 0000 1001 0.
	    0,     0, 0x0304,  // 146  0000 0000 1001 1.
	    0,     0, 0x000d,  // 147  0000 0000 1100 1.
	    0,     0, 0x000c,  // 148  0000 0000 1101 0.
	    0,     0, 0x000e,  // 149  0000 0000 1100 0.
	    0,     0, 0x000f,  // 150  0000 0000 1011 1.
	    0,     0, 0x0205,  // 151  0000 0000 1010 0.
	    0,     0, 0x1a01,  // 152  0000 0000 1101 1.
	    0,     0, 0x0106,  // 153  0000 0000 1011 0.
	180*3, 181*3,      0,  // 154  0000 0000 0111 1
	160*3, 163*3,      0,  // 155  0000 0000 0111 0
	196*3, 199*3,      0,  // 156  0000 0000 0011 10
	    0,     0, 0x001b,  // 157  0000 0000 0101 00.
	203*3, 185*3,      0,  // 158  0000 0000 0010 01
	202*3, 201*3,      0,  // 159  0000 0000 0011 11
	    0,     0, 0x0013,  // 160  0000 0000 0111 00.
	    0,     0, 0x0016,  // 161  0000 0000 0110 01.
	197*3, 207*3,      0,  // 162  0000 0000 0010 00
	    0,     0, 0x0012,  // 163  0000 0000 0111 01.
	191*3, 192*3,      0,  // 164  0000 0000 0001 10
	188*3, 190*3,      0,  // 165  0000 0000 0001 11
	    0,     0, 0x0014,  // 166  0000 0000 0110 11.
	184*3, 194*3,      0,  // 167  0000 0000 0001 01
	    0,     0, 0x0015,  // 168  0000 0000 0110 10.
	186*3, 193*3,      0,  // 169  0000 0000 0001 00
	    0,     0, 0x0017,  // 170  0000 0000 0110 00.
	204*3, 198*3,      0,  // 171  0000 0000 0011 01
	    0,     0, 0x0019,  // 172  0000 0000 0101 10.
	    0,     0, 0x0018,  // 173  0000 0000 0101 11.
	200*3, 205*3,      0,  // 174  0000 0000 0011 00
	    0,     0, 0x001f,  // 175  0000 0000 0100 00.
	    0,     0, 0x001e,  // 176  0000 0000 0100 01.
	    0,     0, 0x001c,  // 177  0000 0000 0100 11.
	    0,     0, 0x001d,  // 178  0000 0000 0100 10.
	    0,     0, 0x001a,  // 179  0000 0000 0101 01.
	    0,     0, 0x0011,  // 180  0000 0000 0111 10.
	    0,     0, 0x0010,  // 181  0000 0000 0111 11.
	189*3, 206*3,      0,  // 182  0000 0000 0010 11
	187*3, 195*3,      0,  // 183  0000 0000 0010 10
	218*3, 211*3,      0,  // 184  0000 0000 0001 010
	    0,     0, 0x0025,  // 185  0000 0000 0010 011.
	215*3, 216*3,      0,  // 186  0000 0000 0001 000
	    0,     0, 0x0024,  // 187  0000 0000 0010 100.
	210*3, 212*3,      0,  // 188  0000 0000 0001 110
	    0,     0, 0x0022,  // 189  0000 0000 0010 110.
	213*3, 209*3,      0,  // 190  0000 0000 0001 111
	221*3, 222*3,      0,  // 191  0000 0000 0001 100
	219*3, 208*3,      0,  // 192  0000 0000 0001 101
	217*3, 214*3,      0,  // 193  0000 0000 0001 001
	223*3, 220*3,      0,  // 194  0000 0000 0001 011
	    0,     0, 0x0023,  // 195  0000 0000 0010 101.
	    0,     0, 0x010b,  // 196  0000 0000 0011 100.
	    0,     0, 0x0028,  // 197  0000 0000 0010 000.
	    0,     0, 0x010c,  // 198  0000 0000 0011 011.
	    0,     0, 0x010a,  // 199  0000 0000 0011 101.
	    0,     0, 0x0020,  // 200  0000 0000 0011 000.
	    0,     0, 0x0108,  // 201  0000 0000 0011 111.
	    0,     0, 0x0109,  // 202  0000 0000 0011 110.
	    0,     0, 0x0026,  // 203  0000 0000 0010 010.
	    0,     0, 0x010d,  // 204  0000 0000 0011 010.
	    0,     0, 0x010e,  // 205  0000 0000 0011 001.
	    0,     0, 0x0021,  // 206  0000 0000 0010 111.
	    0,     0, 0x0027,  // 207  0000 0000 0010 001.
	    0,     0, 0x1f01,  // 208  0000 0000 0001 1011.
	    0,     0, 0x1b01,  // 209  0000 0000 0001 1111.
	    0,     0, 0x1e01,  // 210  0000 0000 0001 1100.
	    0,     0, 0x1002,  // 211  0000 0000 0001 0101.
	    0,     0, 0x1d01,  // 212  0000 0000 0001 1101.
	    0,     0, 0x1c01,  // 213  0000 0000 0001 1110.
	    0,     0, 0x010f,  // 214  0000 0000 0001 0011.
	    0,     0, 0x0112,  // 215  0000 0000 0001 0000.
	    0,     0, 0x0111,  // 216  0000 0000 0001 0001.
	    0,     0, 0x0110,  // 217  0000 0000 0001 0010.
	    0,     0, 0x0603,  // 218  0000 0000 0001 0100.
	    0,     0, 0x0b02,  // 219  0000 0000 0001 1010.
	    0,     0, 0x0e02,  // 220  0000 0000 0001 0111.
	    0,     0, 0x0d02,  // 221  0000 0000 0001 1000.
	    0,     0, 0x0c02,  // 222  0000 0000 0001 1001.
	    0,     0, 0x0f02   // 223  0000 0000 0001 0110.
]);

MPEG1.PICTURE_TYPE = {
	INTRA: 1,
	PREDICTIVE: 2,
	B: 3
};

MPEG1.START = {
	SEQUENCE: 0xB3,
	SLICE_FIRST: 0x01,
	SLICE_LAST: 0xAF,
	PICTURE: 0x00,
	EXTENSION: 0xB5,
	USER_DATA: 0xB2
};

return MPEG1;

})();


JSMpeg.Decoder.MPEG1VideoWASM = (function(){ "use strict";

var MPEG1WASM = function(options) {
	JSMpeg.Decoder.Base.call(this, options);

	this.onDecodeCallback = options.onVideoDecode;
	this.module = options.wasmModule;

	this.bufferSize = options.videoBufferSize || 512*1024;
	this.bufferMode = options.streaming
		? JSMpeg.BitBuffer.MODE.EVICT
		: JSMpeg.BitBuffer.MODE.EXPAND;

	this.decodeFirstFrame = options.decodeFirstFrame !== false;
	this.hasSequenceHeader = false;
};

MPEG1WASM.prototype = Object.create(JSMpeg.Decoder.Base.prototype);
MPEG1WASM.prototype.constructor = MPEG1WASM;

MPEG1WASM.prototype.initializeWasmDecoder = function() {
	if (!this.module.instance) {
		console.warn('JSMpeg: WASM module not compiled yet');
		return;
	}
	this.instance = this.module.instance;
	this.functions = this.module.instance.exports;
	this.decoder = this.functions._mpeg1_decoder_create(this.bufferSize, this.bufferMode);
};

MPEG1WASM.prototype.destroy = function() {
	if (!this.decoder) {
		return;
	}
	this.functions._mpeg1_decoder_destroy(this.decoder);
};

MPEG1WASM.prototype.bufferGetIndex = function() {
	if (!this.decoder) {
		return;
	}
	return this.functions._mpeg1_decoder_get_index(this.decoder);
};

MPEG1WASM.prototype.bufferSetIndex = function(index) {
	if (!this.decoder) {
		return;
	}
	this.functions._mpeg1_decoder_set_index(this.decoder, index);
};

MPEG1WASM.prototype.bufferWrite = function(buffers) {
	if (!this.decoder) {
		this.initializeWasmDecoder();
	}

	var totalLength = 0;
	for (var i = 0; i < buffers.length; i++) {
		totalLength += buffers[i].length;
	}

	var ptr = this.functions._mpeg1_decoder_get_write_ptr(this.decoder, totalLength);
	for (var i = 0; i < buffers.length; i++) {
		this.instance.heapU8.set(buffers[i], ptr);
		ptr += buffers[i].length;
	}
	
	this.functions._mpeg1_decoder_did_write(this.decoder, totalLength);
	return totalLength;
};

MPEG1WASM.prototype.write = function(pts, buffers) {
	JSMpeg.Decoder.Base.prototype.write.call(this, pts, buffers);

	if (!this.hasSequenceHeader && this.functions._mpeg1_decoder_has_sequence_header(this.decoder)) {
		this.loadSequenceHeader();
	}
};

MPEG1WASM.prototype.loadSequenceHeader = function() {
	this.hasSequenceHeader = true;
	this.frameRate = this.functions._mpeg1_decoder_get_frame_rate(this.decoder);
	this.codedSize = this.functions._mpeg1_decoder_get_coded_size(this.decoder);

	if (this.destination) {
		var w = this.functions._mpeg1_decoder_get_width(this.decoder);
		var h = this.functions._mpeg1_decoder_get_height(this.decoder);
		this.destination.resize(w, h);
	}

	if (this.decodeFirstFrame) {
		this.decode();
	}
};

MPEG1WASM.prototype.decode = function() {
	var startTime = JSMpeg.Now();

	if (!this.decoder) {
		return false;
	}

	var didDecode = this.functions._mpeg1_decoder_decode(this.decoder);
	if (!didDecode) {
		return false;
	}

	// Invoke decode callbacks
	if (this.destination) {
		var ptrY = this.functions._mpeg1_decoder_get_y_ptr(this.decoder),
			ptrCr = this.functions._mpeg1_decoder_get_cr_ptr(this.decoder),
			ptrCb = this.functions._mpeg1_decoder_get_cb_ptr(this.decoder);

		var dy = this.instance.heapU8.subarray(ptrY, ptrY + this.codedSize);
		var dcr = this.instance.heapU8.subarray(ptrCr, ptrCr + (this.codedSize >> 2));
		var dcb = this.instance.heapU8.subarray(ptrCb, ptrCb + (this.codedSize >> 2));

		this.destination.render(dy, dcr, dcb, false);
	}

	this.advanceDecodedTime(1/this.frameRate);

	var elapsedTime = JSMpeg.Now() - startTime;
	if (this.onDecodeCallback) {
		this.onDecodeCallback(this, elapsedTime);
	}
	return true;
};

return MPEG1WASM;

})();


JSMpeg.Renderer.Canvas2D = (function(){ "use strict";

var CanvasRenderer = function(options) {
	if (options.canvas) {
		this.canvas = options.canvas;
		this.ownsCanvasElement = false;
	}
	else {
		this.canvas = document.createElement('canvas');
		this.ownsCanvasElement = true;
	}
	this.width = this.canvas.width;
	this.height = this.canvas.height;
	this.enabled = true;

	this.context = this.canvas.getContext('2d');
};

CanvasRenderer.prototype.destroy = function() {
	if (this.ownsCanvasElement) {
		this.canvas.remove();
	}
};

CanvasRenderer.prototype.resize = function(width, height) {
	this.width = width|0;
	this.height = height|0;

	this.canvas.width = this.width;
	this.canvas.height = this.height;

	this.imageData = this.context.getImageData(0, 0, this.width, this.height);
	JSMpeg.Fill(this.imageData.data, 255);
};

CanvasRenderer.prototype.renderProgress = function(progress) {
	var 
		w = this.canvas.width,
		h = this.canvas.height,
		ctx = this.context;

	ctx.fillStyle = '#222';
	ctx.fillRect(0, 0, w, h);
	ctx.fillStyle = '#fff';
	ctx.fillRect(0, h - h * progress, w, h * progress);
};

CanvasRenderer.prototype.render = function(y, cb, cr) {
	this.YCbCrToRGBA(y, cb, cr, this.imageData.data);
	this.context.putImageData(this.imageData, 0, 0);
};

CanvasRenderer.prototype.YCbCrToRGBA = function(y, cb, cr, rgba) {
	if (!this.enabled) {
		return;
	}

	// Chroma values are the same for each block of 4 pixels, so we proccess
	// 2 lines at a time, 2 neighboring pixels each.
	// I wish we could use 32bit writes to the RGBA buffer instead of writing
	// each byte separately, but we need the automatic clamping of the RGBA
	// buffer.
	
	var w = ((this.width + 15) >> 4) << 4,
		w2 = w >> 1;

	var yIndex1 = 0,
		yIndex2 = w,
		yNext2Lines = w + (w - this.width);

	var cIndex = 0,
		cNextLine = w2 - (this.width >> 1);

	var rgbaIndex1 = 0,
		rgbaIndex2 = this.width * 4,
		rgbaNext2Lines = this.width * 4;

	var cols = this.width >> 1,
		rows = this.height >> 1;

	var ccb, ccr, r, g, b;

	for (var row = 0; row < rows; row++) {
		for (var col = 0; col < cols; col++) {
			ccb = cb[cIndex];
			ccr = cr[cIndex];
			cIndex++;

			r = (ccb + ((ccb * 103) >> 8)) - 179;
			g = ((ccr * 88) >> 8) - 44 + ((ccb * 183) >> 8) - 91;
			b = (ccr + ((ccr * 198) >> 8)) - 227;

			// Line 1
			var y1 = y[yIndex1++];
			var y2 = y[yIndex1++];
			rgba[rgbaIndex1]   = y1 + r;
			rgba[rgbaIndex1+1] = y1 - g;
			rgba[rgbaIndex1+2] = y1 + b;
			rgba[rgbaIndex1+4] = y2 + r;
			rgba[rgbaIndex1+5] = y2 - g;
			rgba[rgbaIndex1+6] = y2 + b;
			rgbaIndex1 += 8;

			// Line 2
			var y3 = y[yIndex2++];
			var y4 = y[yIndex2++];
			rgba[rgbaIndex2]   = y3 + r;
			rgba[rgbaIndex2+1] = y3 - g;
			rgba[rgbaIndex2+2] = y3 + b;
			rgba[rgbaIndex2+4] = y4 + r;
			rgba[rgbaIndex2+5] = y4 - g;
			rgba[rgbaIndex2+6] = y4 + b;
			rgbaIndex2 += 8;
		}

		yIndex1 += yNext2Lines;
		yIndex2 += yNext2Lines;
		rgbaIndex1 += rgbaNext2Lines;
		rgbaIndex2 += rgbaNext2Lines;
		cIndex += cNextLine;
	}
};

return CanvasRenderer;

})();



JSMpeg.WASMModule = (function(){ "use strict";

var WASM = function() {
	this.stackSize = 5 * 1024 * 1024; // emscripten default
	this.pageSize = 64 * 1024; // wasm page size
	this.onInitCallbacks = [];
	this.ready = false;
	this.loadingFromFileStarted = false;
	this.loadingFromBufferStarted = false;
};

WASM.prototype.write = function(buffer) {
	this.loadFromBuffer(buffer);
};

WASM.prototype.loadFromFile = function(url, callback) {
	if (callback) {
		this.onInitCallbacks.push(callback);
	}

	// Make sure this WASM Module is only instantiated once. If loadFromFile()
	// was already called, bail out here. On instantiation all pending
	// onInitCallbacks will be called.
	if (this.loadingFromFileStarted) {
		return;
	}
	this.loadingFromFileStarted = true;

	this.onInitCallback = callback;
	var ajax = new JSMpeg.Source.Ajax(url, {});
	ajax.connect(this);
	ajax.start();
};

WASM.prototype.loadFromBuffer = function(buffer, callback) {
	if (callback) {
		this.onInitCallbacks.push(callback);
	}

	// Make sure this WASM Module is only instantiated once. If loadFromBuffer()
	// was already called, bail out here. On instantiation all pending
	// onInitCallbacks will be called.
	if (this.loadingFromBufferStarted) {
		return;
	}
	this.loadingFromBufferStarted = true;

	this.moduleInfo = this.readDylinkSection(buffer);
	if (!this.moduleInfo) {
		for (var i = 0; i < this.onInitCallbacks.length; i++) {
			this.onInitCallbacks[i](null);
		}
		return;
	}

	this.memory = new WebAssembly.Memory({initial: 256});
	var env = {
		memory: this.memory,
		memoryBase: 0,
		__memory_base: 0,
		table: new WebAssembly.Table({initial: this.moduleInfo.tableSize, element: 'anyfunc'}),
		tableBase: 0,
		__table_base: 0,
		abort: this.c_abort.bind(this),
		___assert_fail: this.c_assertFail.bind(this),
		_sbrk: this.c_sbrk.bind(this)
	};

	this.brk = this.align(this.moduleInfo.memorySize + this.stackSize);
	WebAssembly.instantiate(buffer, {env: env}).then(function(results){
		this.instance = results.instance;
		if (this.instance.exports.__post_instantiate) {
			this.instance.exports.__post_instantiate();
		}
		this.createHeapViews();
		this.ready = true;
		for (var i = 0; i < this.onInitCallbacks.length; i++) {
			this.onInitCallbacks[i](this);
		}
	}.bind(this))
};

WASM.prototype.createHeapViews = function() {
	this.instance.heapU8 = new Uint8Array(this.memory.buffer);
	this.instance.heapU32 = new Uint32Array(this.memory.buffer);
	this.instance.heapF32 = new Float32Array(this.memory.buffer);
};

WASM.prototype.align = function(addr) {
	var a = Math.pow(2, this.moduleInfo.memoryAlignment);
	return Math.ceil(addr / a) * a;
};

WASM.prototype.c_sbrk = function(size) {
	var previousBrk = this.brk;
	this.brk += size;

	if (this.brk > this.memory.buffer.byteLength) {
		var bytesNeeded = this.brk - this.memory.buffer.byteLength;
		var pagesNeeded = Math.ceil(bytesNeeded / this.pageSize);
		this.memory.grow(pagesNeeded);
		this.createHeapViews();
	}
	return previousBrk;
};

WASM.prototype.c_abort = function(size) {
	console.warn('JSMPeg: WASM abort', arguments);
};

WASM.prototype.c_assertFail = function(size) {
	console.warn('JSMPeg: WASM ___assert_fail', arguments);
};


WASM.prototype.readDylinkSection = function(buffer) {
	// Read the WASM header and dylink section of the .wasm binary data
	// to get the needed table size and static data size.

	// https://github.com/WebAssembly/tool-conventions/blob/master/DynamicLinking.md
	// https://github.com/kripken/emscripten/blob/20602efb955a7c6c20865a495932427e205651d2/src/support.js

	var bytes = new Uint8Array(buffer);
	var next = 0;

	var readVarUint = function () {
		var ret = 0;
		var mul = 1;
		while (1) {
			var byte = bytes[next++];
			ret += ((byte & 0x7f) * mul);
			mul *= 0x80;
			if (!(byte & 0x80)) {
				return ret
			}
		}
	}

	var matchNextBytes = function(expected) {
		for (var i = 0; i < expected.length; i++) {
			var b = typeof(expected[i]) === 'string' 
				? expected[i].charCodeAt(0)
				: expected[i];
			if (bytes[next++] !== b) {
				return false;
			}
		}
		return true;
	};

	

	// Make sure we have a wasm header
	if (!matchNextBytes([0, 'a', 's', 'm'])) {
		console.warn('JSMpeg: WASM header not found');
		return null;
	}

	// Make sure we have a dylink section
	var next = 9;
	var sectionSize = readVarUint();
	if (!matchNextBytes([6, 'd', 'y', 'l', 'i', 'n', 'k'])) {
		console.warn('JSMpeg: No dylink section found in WASM');
		return null;
	}

	return {
		memorySize: readVarUint(),
		memoryAlignment: readVarUint(),
		tableSize: readVarUint(),
		tableAlignment: readVarUint()
	};
};

WASM.IsSupported = function() {
	return (!!window.WebAssembly);
};

WASM.GetModule = function() {
	WASM.CACHED_MODULE = WASM.CACHED_MODULE || new WASM();
	return WASM.CACHED_MODULE;
};

return WASM;

})();

