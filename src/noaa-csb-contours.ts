import { lonLatToMercator, tileMercatorBounds } from './geo'
import type { CsbSounding } from './noaa-csb'

/** Small, fully observed squares only. No extrapolation across missing bins or surveys. */
export function observedContours(soundings: readonly CsbSounding[], z:number,x:number,y:number) {
  if(z<15) return []
  const size=20
  const cells=new Map<string,{x:number;y:number;depth:number;file:string}>()
  for(const s of soundings){
    const p=lonLatToMercator(s), gx=Math.floor(p.x/size), gy=Math.floor(p.y/size), key=`${gx}:${gy}`
    const old=cells.get(key)
    if(!old) cells.set(key,{x:gx,y:gy,depth:s.depthM,file:s.fileUuid})
    else {old.depth=Math.min(old.depth,s.depthM);if(old.file!==s.fileUuid) old.file=''}
  }
  const bounds=tileMercatorBounds(z,x,y), span=bounds.maxX-bounds.minX
  const result:Array<{ring:Array<{x:number;y:number}>;depth:number}>=[]
  const levels=[2,4,6,8,10,12,14,16,18,20,25,30,40,50,75,100,150,200]
  for(const a of cells.values()){
    const corners=[a,cells.get(`${a.x+1}:${a.y}`),cells.get(`${a.x+1}:${a.y+1}`),cells.get(`${a.x}:${a.y+1}`)]
    if(!a.file || corners.some(c=>!c || c.file!==a.file)) continue
    const points=corners as Array<typeof a>
    for(const depth of levels){
      const ring:Array<{x:number;y:number}>=[]
      for(let i=0;i<4;i++){
        const u=points[i]!,v=points[(i+1)%4]!
        if((u.depth<depth)===(v.depth<depth)) continue
        const t=(depth-u.depth)/(v.depth-u.depth)
        ring.push({x:Math.round((((u.x+.5+t*(v.x-u.x))*size-bounds.minX)/span)*4096),
          y:Math.round(((bounds.maxY-(u.y+.5+t*(v.y-u.y))*size)/span)*4096)})
      }
      // Ambiguous saddle cells are deliberately left blank.
      if(ring.length===2) result.push({ring,depth})
    }
  }
  return result
}
