// vst/mark/src/dpf/DistrhoPluginInfo.h
//
// Metadata follows downspout's normalisation: creator `danja`, group `Downspout`, so the plugins sit together.

#ifndef FLUIDMARK_MARK_DISTRHO_PLUGIN_INFO_H_INCLUDED
#define FLUIDMARK_MARK_DISTRHO_PLUGIN_INFO_H_INCLUDED

#define DISTRHO_PLUGIN_BRAND   "Downspout"
#define DISTRHO_PLUGIN_NAME    "FluidMark"
#define DISTRHO_PLUGIN_URI     "https://danja.github.io/fluidmark/plugins/mark"
#define DISTRHO_PLUGIN_CLAP_ID "it.hyperdata.fluidmark.mark"

#define DISTRHO_PLUGIN_BRAND_ID DnSp
#define DISTRHO_PLUGIN_UNIQUE_ID FlMk

#define DISTRHO_PLUGIN_HAS_UI           1
#define DISTRHO_PLUGIN_IS_RT_SAFE       1
#define DISTRHO_PLUGIN_NUM_INPUTS       2
#define DISTRHO_PLUGIN_NUM_OUTPUTS      2
#define DISTRHO_PLUGIN_WANT_LATENCY     1
#define DISTRHO_PLUGIN_WANT_STATE       1
#define DISTRHO_PLUGIN_WANT_FULL_STATE  1
#define DISTRHO_PLUGIN_WANT_TIMEPOS     1
#define DISTRHO_PLUGIN_VST3_CATEGORIES  "Fx|Tools"
#define DISTRHO_UI_DEFAULT_WIDTH        560
#define DISTRHO_UI_DEFAULT_HEIGHT       360
#define DISTRHO_UI_USE_NANOVG           1
#define DISTRHO_UI_FILE_BROWSER         0

#endif
