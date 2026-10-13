import {useCallback,useEffect,useRef,useState} from 'react';

const STORE='acl.editor.layout.v2';
const DEFAULT={sidebar:44,timeline:34,labels:208,zoom:1,trackHeight:48};
export type LayoutState=typeof DEFAULT;
const clamp=(v:number,min:number,max:number)=>Math.min(max,Math.max(min,v));
function read():LayoutState{
  try{
    const value=JSON.parse(localStorage.getItem(STORE)||'{}');
    return {sidebar:clamp(Number(value.sidebar)||44,28,65),
      timeline:clamp(Number(value.timeline)||34,5,95),
      labels:clamp(Number(value.labels)||208,155,350),
      zoom:clamp(Number(value.zoom)||1,1,80),
      trackHeight:clamp(Number(value.trackHeight)||48,36,180)};
  }catch{return DEFAULT}
}
const ranges:Record<keyof LayoutState,[number,number]>={
  sidebar:[28,65],timeline:[5,95],labels:[155,350],zoom:[1,80],trackHeight:[36,180]
};
export function useEditorLayout(){
  const [layout,setLayout]=useState<LayoutState>(read);
  useEffect(()=>localStorage.setItem(STORE,JSON.stringify(layout)),[layout]);
  const ref=useRef(layout);ref.current=layout;
  const set=useCallback((key:keyof LayoutState,value:number)=>{
    const [min,max]=ranges[key];
    const next=clamp(value,min,max);
    setLayout(old=>old[key]===next?old:{...old,[key]:next});
  },[]);
  return {layout,set,ref};
}
