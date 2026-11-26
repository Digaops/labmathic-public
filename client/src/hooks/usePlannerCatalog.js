import {useEffect,useState} from 'react';
import api from '../services/api';

// A result belongs to its query, never to a newer filter that completed first.
export default function usePlannerCatalog(path,parse){
  const [result,setResult]=useState(null),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    if(!path)return;
    const controller=new AbortController();setResult(null);
    api.get(path,{signal:controller.signal,timeout:15000}).then(response=>{
      const data=parse(response.data);if(!controller.signal.aborted)setResult({path,data});
    }).catch(error=>{if(!controller.signal.aborted)setResult({path,error:error.response?.data?.error||'Não foi possível carregar. Tente novamente.'});});
    return()=>controller.abort();
  },[path,parse,attempt]);
  return {data:result?.path===path?result.data:null,error:result?.path===path?result.error:'',loading:Boolean(path)&&result?.path!==path,retry:()=>setAttempt(n=>n+1)};
}
