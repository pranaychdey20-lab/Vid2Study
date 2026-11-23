const R=new Map(),D=new Map(),F=new Map();
export const putResult=async(o)=>{R.set(o.key,o)}; export const getResult=async(k)=>R.get(k);
export const deleteResult=async(k)=>{R.delete(k)}; export const getDraft=async(k)=>D.get(k);
export const putDraft=async(o)=>{D.set(o.key,structuredClone(o))}; export const deleteDraft=async(k)=>{D.delete(k)};
export const getFrame=async(i)=>F.get(i)||null; export const putFrame=async(i,b)=>{F.set(i,b)};
export const deleteFrames=async()=>{}; export const deleteFrame=async(i)=>{F.delete(i)};
