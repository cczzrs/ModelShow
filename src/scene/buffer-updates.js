/** Keep pending uploads bounded even while an object is culled or rendering is suspended. */
export function mergePendingRange(attribute,start,count){
  let end=start+count;
  for(const range of attribute.updateRanges){start=Math.min(start,range.start);end=Math.max(end,range.start+range.count);}
  attribute.clearUpdateRanges();attribute.addUpdateRange(start,end-start);
  attribute.needsUpdate=true;
}
