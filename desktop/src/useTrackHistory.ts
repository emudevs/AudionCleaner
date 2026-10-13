import {useCallback,useReducer} from 'react';
import type {EditorTrack} from './editor';

type Update=EditorTrack[]|((previous:EditorTrack[])=>EditorTrack[]);
type History={
  present:EditorTrack[];
  past:EditorTrack[][];
  future:EditorTrack[][];
  transaction:EditorTrack[]|null;
};
type Action=
  |{type:'edit';update:Update;record:boolean}
  |{type:'begin'}|{type:'end'}|{type:'undo'}|{type:'redo'}
  |{type:'reset';tracks:EditorTrack[]};

const MAX_HISTORY=80;
export const emptyTrackHistory:History={present:[],past:[],future:[],transaction:null};
function push(stack:EditorTrack[][],value:EditorTrack[]){
  return [...stack.slice(-(MAX_HISTORY-1)),value];
}
export function trackHistoryReducer(state:History,action:Action):History{
  switch(action.type){
    case 'reset':
      return {...emptyTrackHistory,present:action.tracks};
    case 'begin':
      return state.transaction?state:{...state,transaction:state.present};
    case 'end':
      if(!state.transaction)return state;
      if(state.present===state.transaction)return {...state,transaction:null};
      return {...state,transaction:null,past:push(state.past,state.transaction),future:[]};
    case 'edit': {
      const next=typeof action.update==='function'?action.update(state.present):action.update;
      if(next===state.present)return state;
      if(!action.record)return {...state,present:next};
      if(state.transaction)return {...state,present:next,future:[]};
      return {...state,present:next,past:push(state.past,state.present),future:[]};
    }
    case 'undo': {
      const past=state.transaction&&state.present!==state.transaction
        ?push(state.past,state.transaction):state.past;
      const previous=past[past.length-1];
      if(!previous)return {...state,transaction:null};
      return {...state,transaction:null,present:previous,
        past:past.slice(0,-1),future:push(state.future,state.present)};
    }
    case 'redo': {
      if(!state.future.length)return state;
      const next=state.future[state.future.length-1];
      return {...state,transaction:null,present:next,
        future:state.future.slice(0,-1),past:push(state.past,state.present)};
    }
  }
}
export function useTrackHistory(){
  const [history,dispatch]=useReducer(trackHistoryReducer,emptyTrackHistory);
  const setTracks=useCallback((update:Update,record=true)=>
    dispatch({type:'edit',update,record}),[]);
  const resetHistory=useCallback((tracks:EditorTrack[])=>
    dispatch({type:'reset',tracks}),[]);
  const beginHistory=useCallback(()=>dispatch({type:'begin'}),[]);
  const endHistory=useCallback(()=>dispatch({type:'end'}),[]);
  const undo=useCallback(()=>dispatch({type:'undo'}),[]);
  const redo=useCallback(()=>dispatch({type:'redo'}),[]);
  return {tracks:history.present,setTracks,resetHistory,beginHistory,endHistory,
    undo,redo,canUndo:history.past.length>0||Boolean(history.transaction),
    canRedo:history.future.length>0};
}
