// Official live broadcasts verified September 19, 2026.
export const webcams = [
  {id:'dfVK7ld38Ys', title:'Shibuya Crossing - FNN live camera'},
  {id:'ydYDqZQpim8', title:'NamibiaCam - Namib Desert waterhole'},
  {id:'awQzjn72bI0', title:'NASA - International Space Station'}
];

export function createWebcams({play, schedule=setTimeout, cancel=clearTimeout}) {
  let index=0, timer, active=false;
  function show() {
    cancel(timer);
    play(webcams[index],index+1,webcams.length);
    timer=schedule(next,120000);
  }
  function next() {
    if(!active)return;
    index=(index+1)%webcams.length;
    show();
  }
  return {
    current:()=>webcams[index],
    start:()=>{active=true;show();},
    stop:()=>{cancel(timer);if(active)index=(index+1)%webcams.length;active=false;},
    next
  };
}
