import {useCallback,useEffect,useRef,useState} from 'react';
import type {EditorTrack} from './editor';
import {sampleFade} from './editorOperations';

type Channel = {
  element:HTMLMediaElement;
  source:MediaElementAudioSourceNode;
  splitter:ChannelSplitterNode;
  leftGain:GainNode;
  rightGain:GainNode;
  merger:ChannelMergerNode;
  volume:GainNode;
  envelope:GainNode;
  analysers:[AnalyserNode,AnalyserNode];
  analysisBuffers:[Float32Array<ArrayBuffer>,Float32Array<ArrayBuffer>];
};

type Levels=Record<string,[number,number]>;

/**
 * Stereo balance, not stereo pan.
 * The left and right source channels keep their identity:
 *   balance=-1 => L unchanged, R silent
 *   balance= 0 => L unchanged, R unchanged
 *   balance=+1 => L silent, R unchanged.
 * Level analyzers are connected after gain and balance.
 */
export function useAudioMixer(){
  const context=useRef<AudioContext|null>(null);
  const elements=useRef(new Map<string,HTMLMediaElement>());
  const nodes=useRef(new Map<string,Channel>());
  const sourceCache=useRef(new WeakMap<HTMLMediaElement,MediaElementAudioSourceNode>());
  const tracksRef=useRef<EditorTrack[]>([]);
  const [levels,setLevels]=useState<Levels>({});
  // Master mute is a separate gate: never overwrite per-track M/S/gain/pan.
  const [globalMuted,setGlobalMuted]=useState(false);
  const globalMutedRef=useRef(false);

  const apply=useCallback((tracks:EditorTrack[])=>{
    tracksRef.current=tracks;
    const anySolo=tracks.some(t=>t.solo);
    for(const track of tracks){
      const channel=nodes.current.get(track.id);
      if(!channel)continue;
      const audible=!globalMutedRef.current&&!track.muted&&!track.clipMuted&&(!anySolo||track.solo);
      channel.volume.gain.value=audible?Math.max(0,Math.min(12,track.gain*(track.clipGain??1))):0;
      const balance=Math.max(-1,Math.min(1,track.pan));
      channel.leftGain.gain.value=balance>0?1-balance:1;
      channel.rightGain.gain.value=balance<0?1+balance:1;
    }
  },[]);

  const updateEnvelope=useCallback((projectMs:number)=>{
    const ctx=context.current;
    if(!ctx)return;
    for(const track of tracksRef.current){
      const channel=nodes.current.get(track.id);
      if(!channel)continue;
      channel.envelope.gain.setTargetAtTime(sampleFade(track,projectMs),ctx.currentTime,.006);
    }
  },[]);

  const toggleGlobalMute=useCallback(()=>{
    const next=!globalMutedRef.current;
    globalMutedRef.current=next;
    setGlobalMuted(next);
    // Also updates all channels already playing; the new gate is picked up
    // automatically for channels created after this point.
    apply(tracksRef.current);
  },[apply]);

  const disconnect=useCallback((channel:Channel)=>{
    // An element detached by React (or Vite HMR) can continue playing
    // even after it disappears from the editor's element map.
    channel.element.pause();
    channel.source.disconnect();
    channel.splitter.disconnect();
    channel.leftGain.disconnect();
    channel.rightGain.disconnect();
    channel.merger.disconnect();
    channel.volume.disconnect();
    channel.envelope.disconnect();
    for(const analyser of channel.analysers)analyser.disconnect();
  },[]);

  const connect=useCallback((id:string,element:HTMLMediaElement)=>{
    const ctx=context.current;
    if(!ctx)return;
    const existing=nodes.current.get(id);
    if(existing?.element===element)return;
    if(existing){disconnect(existing);nodes.current.delete(id)}
    let source=sourceCache.current.get(element);
    if(!source){
      source=ctx.createMediaElementSource(element);
      sourceCache.current.set(element,source);
    }
    const splitter=ctx.createChannelSplitter(2);
    const leftGain=ctx.createGain(),rightGain=ctx.createGain();
    const merger=ctx.createChannelMerger(2);
    const volume=ctx.createGain();
    const envelope=ctx.createGain();
    const left=ctx.createAnalyser(),right=ctx.createAnalyser();
    left.fftSize=right.fftSize=2048;
    left.smoothingTimeConstant=right.smoothingTimeConstant=.25;

    const track=tracksRef.current.find(t=>t.id===id);
    // Mono files feed both output channels, stereo files retain independent L/R.
    const mono=track?.channels===1;
    source.connect(splitter);
    splitter.connect(leftGain,0,0);
    splitter.connect(rightGain,mono?0:1,0);
    // AnalyserNode passes audio through unchanged. It is in the audible
    // signal path, ensuring live meters work in Chromium, including on pause.
    leftGain.connect(left);
    rightGain.connect(right);
    left.connect(merger,0,0);
    right.connect(merger,0,1);
    merger.connect(volume);
    volume.connect(envelope);
    envelope.connect(ctx.destination);
    const analysisBuffers:[Float32Array<ArrayBuffer>,Float32Array<ArrayBuffer>]=[
      new Float32Array(left.fftSize),new Float32Array(right.fftSize)
    ];
    nodes.current.set(id,{element,source,splitter,leftGain,rightGain,merger,volume,envelope,analysers:[left,right],analysisBuffers});
  },[disconnect]);

  const attach=useCallback((id:string,element:HTMLMediaElement|null)=>{
    if(element)elements.current.set(id,element);
    else{
      const previous=elements.current.get(id);
      if(previous)previous.pause();
      elements.current.delete(id);
      const current=nodes.current.get(id);
      if(current){disconnect(current);nodes.current.delete(id)}
      return;
    }
    if(context.current){connect(id,element);apply(tracksRef.current)}
  },[connect,apply,disconnect]);

  const activate=useCallback(async()=>{
    if(!context.current||context.current.state==='closed'){
      context.current=new AudioContext();
      nodes.current.clear();
      sourceCache.current=new WeakMap();
    }
    for(const [id,element] of elements.current)connect(id,element);
    apply(tracksRef.current);
    await context.current.resume();
  },[connect,apply]);

  useEffect(()=>{
    const timer=window.setInterval(()=>{
      const result:Levels={};
      if(context.current?.state==='running'){
        for(const [id,channel] of nodes.current){
          const pair:[number,number]=[0,0];
          for(let i=0;i<2;i++){
            const buffer=channel.analysisBuffers[i];
            channel.analysers[i].getFloatTimeDomainData(buffer);
            for(const sample of buffer)pair[i]=Math.max(pair[i],Math.abs(sample)*channel.volume.gain.value*channel.envelope.gain.value);
          }
          result[id]=pair;
        }
      }
      // Do not rerender the entire editor while every channel is silent.
      // Coalesce sub-pixel meter changes while preserving changes in activity.
      setLevels(previous=>{
        const keys=Object.keys(result);
        const oldKeys=Object.keys(previous);
        if(keys.length===oldKeys.length && keys.every(id=>{
          const old=previous[id],next=result[id];
          return old && Math.abs(old[0]-next[0])<.004
            && Math.abs(old[1]-next[1])<.004;
        }))return previous;
        return result;
      });
    },85);
    return()=>window.clearInterval(timer);
  },[]);

  useEffect(()=>()=> {
    for(const element of elements.current.values())element.pause();
    for(const channel of nodes.current.values())disconnect(channel);
    nodes.current.clear();
    const ctx=context.current;
    context.current=null;
    if(ctx&&ctx.state!=='closed')void ctx.close();
  },[disconnect]);

  return {attach,activate,apply,updateEnvelope,levels,globalMuted,toggleGlobalMute};
}
