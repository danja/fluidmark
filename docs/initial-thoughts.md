Brainstorming.

The ultimate aim of FluidMark is to create a system that can be used on different platforms to invisibly watermark music files to identify their source. The watermark should survive significant processing and degradation - in both time and frequency domains - of the original signal. This will require a core encoder and decoder.

The crudest watermark is a simple chunk of audio appended to the music file which encodes an identifier. The identifier might as well just be text. The text should probably include a header that declares that there is a watermark, together with basic metadata,then an identifying IRI, then arbitrary text.

We previously made Web Beeps which encoded text into beepy audio. A first pass at a watermark will follow this strategy. A VST plugin based on the patterns of ~/github/downspout which allows the user to enter text and generates a repeated midi pattern derived from it. Think of it being a bassline or melody that could be used on a dance track.

The next phase should determine a good strategy for the steganographic aspects. Read reference/perplexity-pointers.md and download and read the papers linked from it.

Ultimately there should be both a set of native applications and a VST plugin that a user can place in their mastering pipeline that has no psycoacoustic effect but inserts the watermark. The native applications will be able to extract the watermark.