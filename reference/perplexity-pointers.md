Yes. The literature splits into two materially different problems:

1. **Audio-signal steganography** — hide a bitstream in PCM/WAV/MP3 while retaining perceptual transparency and, sometimes, resistance to transcoding or edits.
2. **Symbolic-music steganography** — hide a message in MIDI notes, durations, velocities, chords, timing, or by generating an apparently natural musical piece that encodes it.

For your audio/DSP background, the most relevant starting set is below.

## Recommended papers

| Paper | Carrier / strategy | Why it is useful |
|---|---|---|
| **Bender, Gruhl, Morimoto & Lu, “Techniques for Data Hiding”** (IBM Systems Journal, 1996) | Foundational taxonomy: LSB/low-bit coding, phase coding, spread spectrum, echo hiding | The classic conceptual reference for designing an audio hiding system and understanding the capacity–imperceptibility–robustness trade-off. DOI: 10.1147/sj.353.0313.  [ripublication](https://www.ripublication.com/ijaer10/ijaerv10n4_38.pdf) |
| **K. Gopalan, “Audio Steganography Using Bit Modification”** | PCM/WAV sample-domain embedding | A useful baseline family for bit-plane/sample modification, including why naïve LSB has high capacity but poor resilience to processing. The broader comparative literature evaluates this family explicitly against robustness, security, and payload criteria.  [link.springer](https://link.springer.com/article/10.1186/1687-4722-2012-25?error=cookies_not_supported&code=de755e97-cfdc-4397-a3e8-5294a60d6953) |
| **A. A. Ali et al., “Comparative Study of Digital Audio Steganography Techniques”** (EURASIP Journal on Audio, Speech, and Music Processing, 2012) | Survey and taxonomy: temporal, transform, and robust schemes | Best survey-style entry point. It assesses techniques in terms of hiding capacity, robustness, and security, and describes phase coding as replacement/modulation of selected spectral phase components.  [link.springer](https://link.springer.com/article/10.1186/1687-4722-2012-25?error=cookies_not_supported&code=de755e97-cfdc-4397-a3e8-5294a60d6953) |
| **Mishra, Yadav, Trivedi & Shrimali, “Audio Steganography Techniques: A Survey”** (2018) | Survey of audio data-hiding methods | A compact literature map covering methods and their comparative strengths/limits. DOI: 10.1007/978-981-10-3773-3_56.  [link.springer](https://link.springer.com/chapter/10.1007/978-981-10-3773-3_56?error=cookies_not_supported&code=7e271238-5fe3-4368-9684-9c93df9aaf96) |
| **Bajor & Niemiec, “A New Steganographic Algorithm for Hiding Messages in Music”** (Information & Security, 2020) | **MIDI** / musical structure; machine-learning-related approach | Directly relevant if you mean actual *music files* rather than arbitrary audio containers. It treats MIDI as the carrier and seeks a more music-native relationship between the embedded data and the medium. DOI: 10.11610/isij.4718.  [isij](https://isij.eu/system/files/download-count/2023-01/4718_hiding_messages_in_music.pdf) |
| **“Message-Driven Generative Music Steganography Using MIDI-GAN”** (IEEE Transactions on Emerging Topics in Computing, 2024) | Generative MIDI; GAN generator, discriminator, extractor | Modern approach: generate the MIDI itself from the secret payload rather than perturbing an existing score. The discriminator is trained to make output statistically resemble authentic MIDI, while an extractor recovers the message.  [computer](https://www.computer.org/csdl/journal/tq/2024/06/10457038/1UXtpA090cw) |
| **“A Novel Steganography Approach for Audio Files”** (SN Computer Science, 2021) | WAV; adaptive/multiple LSB layers; encrypted compressed image payload | Concrete high-capacity engineering paper. It combines payload compression/encryption with variable multi-LSB substitution and evaluates SNR/PSNR plus listening tests. DOI: 10.1007/s42979-020-0080-2.  [link.springer](https://link.springer.com/article/10.1007/s42979-020-0080-2) |
| **“Stereo Audio Steganography based on Mid/Side Processing”** (Veri Bilimi, 2025) | Stereo music; \(M/S\) decomposition, side-channel payload embedding | Particularly relevant for production-oriented experimentation: it separates mid and side components and puts payload into a controlled side component, reporting retained payload integrity after MP3 compression.  [dergipark.org](https://dergipark.org.tr/en/pub/veri/article/1564733) |
| **“An Improved Phase Coding Audio Steganography Algorithm”** (arXiv, 2024) | Segment-wise phase coding, synchronization framing, CRC-16, Hamming(7,4) | A practical modernized version of phase coding. It distributes payload across segments and adds real communications-system necessities: sync word, length field, checksum, and forward error correction.  [arxiv](https://arxiv.org/html/2408.13277v3) |
| **StegoHound: “A Novel Multi-Approaches Method for Efficient and Effective Identification and Extraction of Digital Evidence Masked by Steganographic Techniques in WAV and MP3 Files”** (2023) | WAV/MP3 steganalysis and forensic extraction | Read this alongside embedding papers. It is about detection and recovery, useful for avoiding simplistic designs that are trivially identifiable.  [arxiv](https://arxiv.org/ftp/arxiv/papers/2307/2307.07293.pdf) |

## Strategy map

### 1. PCM / WAV sample-domain methods

**LSB substitution** replaces one or more low-order sample bits with payload bits:

\[
x'[n] = (x[n] \mathbin{\&} \sim(2^k-1)) \;|\; m_k[n]
\]

where \(k\) is the number of altered low bit planes and \(m_k[n]\) is the payload chunk.

- **Strengths:** trivial implementation, excellent raw capacity, easy keyed permutation of sample positions.
- **Weaknesses:** fragile under resampling, normalization, gain changes, dithering, lossy transcode, filtering, and re-encoding; statistically detectable if payload placement is naïve.
- **Best fit:** lossless WAV/FLAC transport where capacity matters more than survival under processing.

The recent WAV work above claims up to multiple variable LSB layers and uses compression/encryption before embedding; its claimed imperceptibility is evaluated through listening and SNR-style measures. [link.springer](https://link.springer.com/article/10.1007/s42979-020-0080-2)

### 2. Transform-domain embedding

Transform the waveform via STFT, MDCT, DCT, or wavelets; then embed into selected coefficients:

\[
X'[k,t] = X[k,t] + \alpha \, b_t \, w[k,t]
\]

where \(b_t \in \{-1,+1\}\) carries the payload and \(w\) selects/masks coefficient regions.

- **Strengths:** lets you exploit spectral masking and avoid exposed low-energy or perceptually sensitive regions.
- **Weaknesses:** synchronization, parameter tuning, decoder design, and host interference are harder.
- **Best fit:** a serious robust design that should survive some processing.

The literature broadly distinguishes direct time-domain approaches from transform-domain approaches such as cosine-transform schemes. [dafx12.york.ac](https://www.dafx12.york.ac.uk/papers/dafx12_submission_54.pdf)

### 3. Phase coding

Encode data through controlled changes to spectral phase rather than magnitude. This follows the psychoacoustic premise that certain relative phase changes can be less obvious than direct additive noise; the comparative survey specifically describes selected phase components being replaced with hidden data. [link.springer](https://link.springer.com/article/10.1186/1687-4722-2012-25?error=cookies_not_supported&code=de755e97-cfdc-4397-a3e8-5294a60d6953)

- **Strengths:** potentially strong transparency if phase manipulation is coherent across frames.
- **Weaknesses:** easily broken by arbitrary cuts, time-scale modification, resampling, or phase-altering processing unless synchronization is carefully engineered.
- **Practical direction:** the 2024 phase-coding paper’s segment distribution, framing, CRC-16, and Hamming coding are good systems-design additions beyond the classical algorithm. [arxiv](https://arxiv.org/html/2408.13277v3)

### 4. Echo hiding

Encode bits with one of two or more near-inaudible echoes. Typical symbols may be represented by changes in delay, amplitude, or decay:

\[
y[n] = x[n] + \alpha x[n-d_b]
\]

where \(d_b\) is a bit-dependent delay.

- **Strengths:** can be more robust than naïve sample-bit manipulation.
- **Weaknesses:** repeated material, sparse arrangements, transient-heavy drums, and mix/master processing can reveal or damage the echo structure.
- **Music-production relevance:** a wide, dense, noisy mix is usually a much friendlier host than dry solo percussion or exposed vocal material.

The standard literature identifies amplitude, decay rate, and offset/delay as the controllable echo parameters. [arxiv](https://www.arxiv.org/pdf/1111.3758.pdf)

### 5. Spread spectrum

Spread each bit or symbol using a keyed pseudo-noise sequence over time and/or frequency:

\[
y[n] = x[n] + \alpha b \, p[n]
\]

with \(p[n]\) a secret pseudo-random sequence.

- **Strengths:** less locally conspicuous; can have good robustness when paired with psychoacoustic masking, redundancy, interleaving, and correlation decoding.
- **Weaknesses:** low payload rate; host interference and synchronization dominate performance.
- **Best fit:** watermark-like payloads, identifiers, short commands, hashes, or authentication data—not high-volume hidden content.

Surveys describe spread-spectrum embedding as spreading payload throughout the signal spectrum rather than putting it in direct sample positions. [65610.csail.mit](https://65610.csail.mit.edu/2024/reports/hong-kumar-huang.pdf)

### 6. MP3 codec-domain embedding

Rather than hiding data in decoded PCM, modify encoding decisions or fields inside the MP3 process. **MP3Stego** is the canonical example: it embeds during MP3 encoding by controlling the parity of `part2_3_length` through the encoder’s inner-loop termination/quantization process. [arxiv](https://arxiv.org/pdf/1709.08084.pdf)

- **Strengths:** designed for the compressed format; avoids a separate decode–modify–reencode workflow.
- **Weaknesses:** format-specific, relatively well-known to steganalysis, and subsequent transcoding can destroy it.
- **Best fit:** research/forensics experiments with a controlled MP3 toolchain, not a durable platform-independent design.

## MIDI-specific approaches

For a modular or algorithmic composition workflow, MIDI steganography can be much more interesting than waveform hiding because it supports semantic and structural carriers:

- **Pitch choice:** choose between musically equivalent alternatives, scale degrees, voicing permutations, or ornament types to represent symbols.
- **Rhythm and duration:** encode with quantization-grid choices, duration classes, accents, rests, microtiming bins, or rhythmic motifs.
- **Velocity / CC lanes:** use constrained velocity levels or controller states, but beware DAW cleanup, humanization, and quantization.
- **Chord selection:** map payload bits to chord substitutions within a shared harmonic function.
- **Event ordering / note pairing:** encode through equivalent ordering of simultaneous notes or alternative representations.
- **Generative coding:** condition a music generator on payload bits and train an extraction network. MIDI-GAN is the clearest paper in this category from the search results. [computer](https://www.computer.org/csdl/journal/tq/2024/06/10457038/1UXtpA090cw)

A robust symbolic scheme should not simply map ASCII bits directly onto arbitrary notes. Better is:

1. Encrypt/authenticate the payload.
2. Apply error correction and interleaving.
3. Map coded symbols to *musically equivalent constrained choices*.
4. Use a secret key to choose the available alternative at each musical decision.
5. Preserve a canonicalization-resistant representation: e.g., do not depend on MIDI event ordering that an export/import cycle may rewrite.

## A practical research path

If you want to prototype this as an audio-DSP project, I would prioritize:

1. **Build a baseline WAV testbed** with keyed, permuted 1-LSB embedding, payload encryption, a sync header, CRC, and Reed–Solomon or convolutional/FEC layer. This makes the baseline measurable but not robust.
2. **Implement STFT or MDCT QIM** using masking-aware bins in dense spectral regions. Quantization-index modulation is generally a more principled path than unrestricted coefficient offsets.
3. **Benchmark attacks**: gain, normalization, dither, resample, low-pass/high-pass, time shift, crop, MP3/AAC/Opus transcode, stereo-to-mono, and a DAW render/re-import cycle.
4. **Measure perceptual as well as signal metrics**: payload BER/FER after attack, objective difference grades or perceptual metrics where available, plus ABX/listening tests. SNR alone is not a sufficient proxy for audibility.
5. **For MIDI**, prototype a constrained grammar or harmonic/rhythmic model before moving to neural generation. It will be far easier to verify capacity, extraction reliability, and musical plausibility than an end-to-end GAN system.

## Important distinction

If your goal is **copyright/provenance**, look primarily at *robust audio watermarking*, which aims to survive processing and commonly accepts a small payload. If your goal is **covert communication**, use steganography, which emphasizes undetectability and secrecy but can be more fragile. The comparative survey explicitly frames the core evaluation axes as capacity, robustness, and security; in practice you cannot maximize all three simultaneously. [link.springer](https://link.springer.com/article/10.1186/1687-4722-2012-25?error=cookies_not_supported&code=de755e97-cfdc-4397-a3e8-5294a60d6953)

For music that may be rendered, transcoded, mastered, or streamed, a low-rate transform-domain or spread-spectrum watermark is generally a more defensible research direction than LSB. For a MIDI-only exchange under your control, structural/generative MIDI steganography is likely the most musically interesting route.