import{p as rt}from"./chunk-JWPE2WC7.js";import{V as D,bO as B,i as nt,ah as it,by as ot,ai as st,bz as lt,am as ct,bB as ut,c as d,b6 as G,al as gt,M as dt,bx as pt,bh as ht,T as ft,N as mt,a7 as vt}from"./index2.js";import{p as xt}from"./cynefin-OW5HDTMX.js";import"./index.js";import{d as J}from"./arc.js";import{o as yt}from"./ordinal.js";import"./init.js";function St(t,n){return n<t?-1:n>t?1:n>=t?0:NaN}function wt(t){return t}function At(){var t=wt,n=St,S=null,T=D(0),l=D(B),p=D(0);function i(e){var r,s=(e=nt(e)).length,h,w,$=0,f=new Array(s),o=new Array(s),b=+T.apply(this,arguments),M=Math.min(B,Math.max(-B,l.apply(this,arguments)-b)),k,L=Math.min(Math.abs(M)/s,p.apply(this,arguments)),u=L*(M<0?-1:1),A;for(r=0;r<s;++r)(A=o[f[r]=r]=+t(e[r],r,e))>0&&($+=A);for(n!=null?f.sort(function(E,m){return n(o[E],o[m])}):S!=null&&f.sort(function(E,m){return S(e[E],e[m])}),r=0,w=$?(M-s*u)/$:0;r<s;++r,b=k)h=f[r],A=o[h],k=b+(A>0?A*w:0)+u,o[h]={data:e[h],index:r,value:A,startAngle:b,endAngle:k,padAngle:L};return o}return i.value=function(e){return arguments.length?(t=typeof e=="function"?e:D(+e),i):t},i.sortValues=function(e){return arguments.length?(n=e,S=null,i):n},i.sort=function(e){return arguments.length?(S=e,n=null,i):S},i.startAngle=function(e){return arguments.length?(T=typeof e=="function"?e:D(+e),i):T},i.endAngle=function(e){return arguments.length?(l=typeof e=="function"?e:D(+e),i):l},i.padAngle=function(e){return arguments.length?(p=typeof e=="function"?e:D(+e),i):p},i}var Ct=vt.pie,I={sections:new Map,showData:!1},W=I.sections,V=I.showData,$t=structuredClone(Ct),bt=d(()=>structuredClone($t),"getConfig"),Dt=d(()=>{W=new Map,V=I.showData,mt()},"clear"),Tt=d(({label:t,value:n})=>{if(n<0)throw new Error(`"${t}" has invalid value: ${n}. Negative values are not allowed in pie charts. All slice values must be >= 0.`);W.has(t)||(W.set(t,n),G.debug(`added new section: ${t}, with value: ${n}`))},"addSection"),kt=d(()=>W,"getSections"),zt=d(t=>{V=t},"setShowData"),Mt=d(()=>V,"getShowData"),K={getConfig:bt,clear:Dt,setDiagramTitle:ut,getDiagramTitle:ct,setAccTitle:lt,getAccTitle:st,setAccDescription:ot,getAccDescription:it,addSection:Tt,getSections:kt,setShowData:zt,getShowData:Mt},Et=d((t,n)=>{rt(t,n),n.setShowData(t.showData),t.sections.map(n.addSection)},"populateDb"),Rt={parse:d(async t=>{const n=await xt("pie",t);G.debug(n),Et(n,K)},"parse")},Lt=d(t=>`
  .pieCircle{
    stroke: ${t.pieStrokeColor};
    stroke-width : ${t.pieStrokeWidth};
    opacity : ${t.pieOpacity};
  }
  .pieCircle.highlighted{
    scale: 1.05;
    opacity: 1;
  }
  .pieCircle.highlightedOnHover:hover{
    transition-duration: 250ms;
    scale: 1.05;
    opacity: 1;
  }
  .pieOuterCircle{
    stroke: ${t.pieOuterStrokeColor};
    stroke-width: ${t.pieOuterStrokeWidth};
    fill: none;
  }
  .pieTitleText {
    text-anchor: middle;
    font-size: ${t.pieTitleTextSize};
    fill: ${t.pieTitleTextColor};
    font-family: ${t.fontFamily};
  }
  .slice {
    font-family: ${t.fontFamily};
    fill: ${t.pieSectionTextColor};
    font-size:${t.pieSectionTextSize};
    // fill: white;
  }
  .legend text {
    fill: ${t.pieLegendTextColor};
    font-family: ${t.fontFamily};
    font-size: ${t.pieLegendTextSize};
  }
`,"getStyles"),Nt=Lt,Ot=d(t=>{const n=[...t.values()].reduce((l,p)=>l+p,0),S=[...t.entries()].map(([l,p])=>({label:l,value:p})).filter(l=>l.value/n*100>=1);return At().value(l=>l.value).sort(null)(S)},"createPieArcs"),Wt=d((t,n,S,T)=>{var q;G.debug(`rendering pie chart
`+t);const l=T.db,p=gt(),i=dt(l.getConfig(),p.pie),e=40,r=18,s=4,h=450,w=h,$=pt(n),f=$.append("g");f.attr("transform","translate("+w/2+","+h/2+")");const{themeVariables:o}=p;let[b]=ht(o.pieOuterStrokeWidth);b??(b=2);const M=i.legendPosition,k=i.textPosition,L=i.donutHole>0&&i.donutHole<=.9?i.donutHole:0,u=Math.min(w,h)/2-e,A=J().innerRadius(L*u).outerRadius(u),E=J().innerRadius(u*k).outerRadius(u*k),m=f.append("g");m.append("circle").attr("cx",0).attr("cy",0).attr("r",u+b/2).attr("class","pieOuterCircle");const N=l.getSections(),Q=Ot(N),Y=[o.pie1,o.pie2,o.pie3,o.pie4,o.pie5,o.pie6,o.pie7,o.pie8,o.pie9,o.pie10,o.pie11,o.pie12];let F=0;N.forEach(a=>{F+=a});const U=Q.filter(a=>(a.data.value/F*100).toFixed(0)!=="0"),H=yt(Y).domain([...N.keys()]);m.selectAll("mySlices").data(U).enter().append("path").attr("d",A).attr("fill",a=>H(a.data.label)).attr("class",a=>{let c="pieCircle";return i.highlightSlice==="hover"?c+=" highlightedOnHover":i.highlightSlice===a.data.label&&(c+=" highlighted"),c}),m.selectAll("mySlices").data(U).enter().append("text").text(a=>(a.data.value/F*100).toFixed(0)+"%").attr("transform",a=>"translate("+E.centroid(a)+")").style("text-anchor","middle").attr("class","slice");const tt=f.append("text").text(l.getDiagramTitle()).attr("x",0).attr("y",-400/2).attr("class","pieTitleText"),R=[...N.entries()].map(([a,c])=>({label:a,value:c})),C=f.selectAll(".legend").data(R).enter().append("g").attr("class","legend");C.append("rect").attr("width",r).attr("height",r).style("fill",a=>H(a.label)).style("stroke",a=>H(a.label)),C.append("text").attr("x",r+s).attr("y",r-s).text(a=>l.getShowData()?`${a.label} [${a.value}]`:a.label);const z=Math.max(...C.selectAll("text").nodes().map(a=>(a==null?void 0:a.getBoundingClientRect().width)??0));let O=h,P=w+e;const g=r+s,_=R.length*g;switch(M){case"center":C.attr("transform",(a,c)=>{const v=g*R.length/2,x=-z/2-(r+s),y=c*g-v;return"translate("+x+","+y+")"});break;case"top":O+=_,C.attr("transform",(a,c)=>{const v=u,x=-z/2-(r+s),y=c*g-v;return`translate(${x}, ${y})`}),m.attr("transform",()=>`translate(0, ${_+g})`);break;case"bottom":O+=_,C.attr("transform",(a,c)=>{const v=-u-g,x=-z/2-(r+s),y=c*g-v;return"translate("+x+","+y+")"});break;case"left":P+=r+s+z,C.attr("transform",(a,c)=>{const v=g*R.length/2,x=-u-(r+s),y=c*g-v;return"translate("+x+","+y+")"}),m.attr("transform",()=>`translate(${z+r+s}, 0)`);break;case"right":default:P+=r+s+z,C.attr("transform",(a,c)=>{const v=g*R.length/2,x=12*r,y=c*g-v;return"translate("+x+","+y+")"});break}const j=((q=tt.node())==null?void 0:q.getBoundingClientRect().width)??0,et=w/2-j/2,at=w/2+j/2,X=Math.min(0,et),Z=Math.max(P,at)-X;$.attr("viewBox",`${X} 0 ${Z} ${O}`),ft($,O,Z,i.useMaxWidth)},"draw"),Ft={draw:Wt},jt={parser:Rt,db:K,renderer:Ft,styles:Nt};export{jt as diagram};
