// Node validation driver for independently compiled family modules; never used by playback.
import {readFileSync} from 'node:fs';
const sharedProfile=readFileSync(new URL('../../../../engine-sound/src/legacyProfile.ts',import.meta.url),'utf8');
function fields(name){return [...sharedProfile.split(`export const ${name} = [`)[1].split('] as const')[0].matchAll(/"([^"]+)"/g)].map(m=>m[1]);}
const jet=fields('JET_ACOUSTIC_PROFILE_FIELDS'),piston=fields('PISTON_ACOUSTIC_PROFILE_FIELDS');
export async function createFamilyPipeline(host,{sampleRate,seed=0x53463530,engine='FJ33'}={}){
 if(typeof host.osfs_audio_prepare!=='function')return {process:(frame,frames)=>host.osfs_audio_process(frame,frames)};
 const mod=JSON.parse(readFileSync(new URL(`../../../../${engine}/public/0sfs-mod.json`,import.meta.url)));
 const profile=mod.engine.acousticProfile,p=profile.parameters,isPiston=profile.engineClass==='piston',family=isPiston?'piston':'turbine';
 const values=[...jet.map(k=>isPiston?0:p[k]),isPiston?1:0,...piston.map(k=>isPiston?p[k]:0)];
 const module=await WebAssembly.compile(readFileSync(new URL(`../../../../${family}-sound/public/audio/${family}-sound/voice.wasm`,import.meta.url)));
 const voice=new WebAssembly.Instance(module,{}).exports;voice._initialize?.();if(voice.osfs_voice_abi_version()!==1||!voice.osfs_voice_init(sampleRate,1024,seed,1))throw Error('Voice setup failed');
 new Float64Array(voice.memory.buffer,voice.osfs_voice_profile_ptr(0),voice.osfs_voice_profile_size()).set(values);if(!voice.osfs_voice_commit_profile(0))throw Error('Voice profile rejected');
 host.osfs_audio_set_source_type(0);host.osfs_audio_set_sources(1,isPiston?p.pistonCockpitGain:.12589254117941673,isPiston?p.pistonCockpitHz:1200,isPiston?p.pistonCockpitGain:p.highCockpitGain,isPiston?p.pistonCockpitHz:p.highCockpitHz);
 const prepared=new Float64Array(host.memory.buffer,host.osfs_audio_voice_input_ptr(),4*1024*32),input=new Float64Array(voice.memory.buffer,voice.osfs_voice_input_ptr(),4*1024*32),output=new Float64Array(voice.memory.buffer,voice.osfs_voice_output_ptr(),4*2*1024),mixed=new Float64Array(host.memory.buffer,host.osfs_audio_voice_output_ptr(),4*2*1024);
 return {process(frame,frames){host.osfs_audio_prepare(frame,frames);for(let i=0;i<frames*32;i++)input[i]=prepared[i];if(!voice.osfs_voice_process(frames))throw Error('Voice block rejected');for(let b=0;b<2;b++)for(let i=0;i<frames;i++)mixed[b*1024+i]=output[b*1024+i];host.osfs_audio_mix(frame,frames);}};
}
