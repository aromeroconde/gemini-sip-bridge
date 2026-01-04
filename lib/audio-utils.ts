/**
 * Audio transcoding utilities for SIP (G.711 Mu-law) to Gemini (PCM 16-bit)
 */

const muLawToLinearTable = new Int16Array(256);

for (let i = 0; i < 256; i++) {
    let muLaw = ~i;
    let sign = (muLaw & 0x80);
    let exponent = (muLaw & 0x70) >> 4;
    let mantissa = muLaw & 0x0F;
    let sample = (mantissa << 3) + 132;
    sample <<= exponent;
    sample -= 132;
    muLawToLinearTable[i] = sign ? -sample : sample;
}

export function muLawToPcm(buffer: Buffer): Buffer {
    const pcm = Buffer.alloc(buffer.length * 2);
    for (let i = 0; i < buffer.length; i++) {
        const sample = muLawToLinearTable[buffer[i]];
        pcm.writeInt16LE(sample, i * 2);
    }
    return pcm;
}

/**
 * Resample from 8kHz to 16kHz using Linear Interpolation
 */
export function resample8To16(buffer: Buffer): Buffer {
    const inputSamples = buffer.length / 2;
    const outputSamples = inputSamples * 2;
    const resampled = Buffer.alloc(outputSamples * 2);

    for (let i = 0; i < outputSamples; i++) {
        const position = i / 2;
        const index = Math.floor(position);
        const fraction = position - index;

        const s1 = buffer.readInt16LE(index * 2);
        const s2 = (index + 1 < inputSamples) ? buffer.readInt16LE((index + 1) * 2) : s1;

        const sample = Math.round(s1 * (1 - fraction) + s2 * fraction);
        resampled.writeInt16LE(sample, i * 2);
    }
    return resampled;
}

export function pcmToMuLaw(buffer: Buffer): Buffer {
    const mulaw = Buffer.alloc(buffer.length / 2);
    for (let i = 0; i < buffer.length; i += 2) {
        let sample = buffer.readInt16LE(i);
        mulaw[i / 2] = encodeMuLaw(sample);
    }
    return mulaw;
}

function encodeMuLaw(sample: number): number {
    const sign = (sample < 0) ? 0x80 : 0x00;
    if (sample < 0) sample = -sample;
    sample += 132;
    if (sample > 32767) sample = 32767;

    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
        exponent--;
    }
    let mantissa = (sample >> (exponent + 3)) & 0x0F;
    let res = (sign | (exponent << 4) | mantissa);
    return ~(res & 0xFF) & 0xFF;
}

/**
 * Resample from 24kHz to 8kHz using average of samples (Downsampling)
 */
export function resample24To8(buffer: Buffer): Buffer {
    const inputSamples = buffer.length / 2;
    const outputSamples = Math.floor(inputSamples / 3);
    const resampled = Buffer.alloc(outputSamples * 2);

    for (let i = 0; i < outputSamples; i++) {
        // Average 3 samples to reduce aliasing
        const s1 = buffer.readInt16LE(i * 6);
        const s2 = buffer.readInt16LE(i * 6 + 2);
        const s3 = buffer.readInt16LE(i * 6 + 4);

        const avgSample = Math.round((s1 + s2 + s3) / 3);
        resampled.writeInt16LE(avgSample, i * 2);
    }
    return resampled;
}
