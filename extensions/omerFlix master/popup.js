/**
 * omerFlix MASTER v7.2 - True HRTF 3D & 360° 8D Audio Engine
 * NÜKLEER BOOST LİMİTLERİ KALDIRILDI!
 */

let appState = {
  volume:1.0, bass:0, treble:0, device:'pc', monsterMode:false, nuke:false,
  eightD:false, slowed:false, karaoke:false, spatial:false, compressor:false, mono:false,
  under:false, mega:false, rape:false, concert:false, chip:false, demon:false, lofi:false, sub:false, tremolo:false, echo:false
};
let protSettings = { trackers:true, ads:true, virus:true, sponsor:true };
let audioData = new Array(32).fill(0);
let shakeInjected = false;

function getActiveTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true }, tabs => {
      if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError.message);
      resolve(tabs && tabs[0]);
    });
  });
}

function executeInTab(tabId, func, args = []) {
  const executeLegacy = () => {
    const code = `(${func.toString()})(...${JSON.stringify(args)});`;
    return new Promise(resolve => {
      chrome.tabs.executeScript(tabId, { code }, result => {
        if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError.message);
        resolve(result);
      });
    });
  };

  if (chrome.scripting && chrome.scripting.executeScript) {
    try {
      return chrome.scripting.executeScript({ target: { tabId }, func, args }).catch(executeLegacy);
    } catch (error) {
      console.warn(error.message);
    }
  }
  return executeLegacy();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "AUDIO_VISUALIZER_DATA") audioData = msg.data;
});

function showTab(name) {
  ['ses','koruma'].forEach(t => {
    document.getElementById('tab'+t.charAt(0).toUpperCase()+t.slice(1)).classList.toggle('active', t===name);
    document.getElementById('tab'+t.charAt(0).toUpperCase()+t.slice(1)+'Btn').classList.toggle('active', t===name);
  });
  if (name === 'koruma') loadStats();
}

function loadStats() {
  chrome.runtime.sendMessage({ type:'GET_STATS' }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    document.getElementById('statTrackers').textContent  = res.trackers  || 0;
    document.getElementById('statAds').textContent       = res.ads       || 0;
    document.getElementById('statDownloads').textContent = res.downloads || 0;
  });
}

const PROT_KEYS = ['Trackers','Ads','Virus','Sponsor'];

function renderProtUI() {
  const map = {
    Trackers:{ on:'🚫 İzleyici Engelleme: AÇIK', off:'🚫 İzleyici Engelleme: KAPALI' },
    Ads:     { on:'📺 Reklam Engelleme: AÇIK',    off:'📺 Reklam Engelleme: KAPALI' },
    Virus:   { on:'🦠 Virüs Koruması: AÇIK',      off:'🦠 Virüs Koruması: KAPALI' },
    Sponsor: { on:'🎬 Sponsorluk Atla: AÇIK',     off:'🎬 Sponsorluk Atla: KAPALI' }
  };
  PROT_KEYS.forEach(key => {
    const k=key.toLowerCase();
    const on=protSettings[k];
    const row=document.getElementById('row'+key);
    const ind=document.getElementById('ind'+key);
    const nameEl=row?.querySelector('.t-name');
    if (nameEl) nameEl.textContent=on?map[key].on:map[key].off;
    if (row) row.classList.toggle('off',!on);
    if (ind) ind.textContent=on?'✅':'❌';
  });
}

function applyProtSettings() {
  chrome.storage.local.set({ protSettings });
  chrome.tabs.query({ active:true }, (tabs) => {
    if (!tabs[0]) return;
    executeInTab(tabs[0].id, (s)=>{ window.__omfSettings=s; }, [protSettings]);
  });
  renderProtUI();
}

function setupVisualizer() {
  const canvas=document.getElementById('canvas');
  if (!canvas) return;
  const ctx=canvas.getContext('2d');
  (function render() {
    ctx.clearRect(0,0,canvas.width,canvas.height);
    canvas.style.transform=(appState.monsterMode || appState.nuke)
      ?`translate(${Math.random()*8-4}px,${Math.random()*8-4}px)`:'none';
    for (let i=0;i<30;i++) {
      const val=audioData[i]||0;
      const h=Math.max(3,(val/255)*canvas.height*1.5);
      ctx.fillStyle=appState.nuke?'#ea80fc':appState.monsterMode?`rgb(${150+val},0,0)`:'#00ffcc';
      ctx.fillRect(i*12,canvas.height-h,9,h);
    }
    requestAnimationFrame(render);
  })();
}

async function injectShakeLoop(tabId) {
  if (shakeInjected) return;
  shakeInjected=true;
  executeInTab(tabId, ()=>{
      if (window.__omfShakeLoop) return;
      window.__omfShakeLoop=true;
      window.__omfMonsterOn=false;
      window.__omfNukeOn=false;
      (function shake(){
        try {
          if ((window.__omfMonsterOn || window.__omfNukeOn)&&window.__omfAnalyser) {
            const d=new Uint8Array(window.__omfAnalyser.frequencyBinCount);
            window.__omfAnalyser.getByteFrequencyData(d);
            const b=(d[0]+d[1]+d[2])/3;
            if (b>40) {
              const s=(window.__omfDevice==='board' || window.__omfNukeOn)?b/1.5:b/8; 
              document.documentElement.style.transform=
                `translate(${(Math.random()*s-s/2).toFixed(1)}px,${(Math.random()*s-s/2).toFixed(1)}px)`;
              document.documentElement.style.outline=`${(b/6).toFixed(1)}px solid ${window.__omfNukeOn?'#ea80fc':'red'}`;
              document.documentElement.style.outlineOffset=`-${(b/6).toFixed(1)}px`;
            } else {
              document.documentElement.style.transform='none';
              document.documentElement.style.outline='none';
            }
          } else {
            document.documentElement.style.transform='none';
            document.documentElement.style.outline='none';
          }
        } catch(e){}
        requestAnimationFrame(shake);
      })();
  });
}

async function setMonsterState(tabId,on,device,nuke) {
  executeInTab(tabId, (on,device,nuke)=>{window.__omfMonsterOn=on;window.__omfDevice=device;window.__omfNukeOn=nuke;}, [on,device,nuke]);
}

async function updateEngine() {
  const tab = await getActiveTab();
  if (!tab) return;

  const raw=parseInt(document.getElementById('volume').value); 
  let calcVol = raw/100;
  
  if (appState.monsterMode) {
    if (appState.device === 'board') {
      calcVol = calcVol * 500000000;
    } else {
      calcVol = calcVol * 100000;
    }
  } else {
    calcVol = calcVol * 1; 
  }
  
  // 🔥 NÜKLEER MOD İÇİN YENİ ÇARPAN: 50 MİLYON!
  if (appState.nuke) {
    calcVol = calcVol * 50000000;
  }
  
  appState.volume = calcVol;
  appState.bass=parseFloat(document.getElementById('bass').value);
  appState.treble=parseFloat(document.getElementById('treble').value);

  await injectShakeLoop(tab.id);
  await setMonsterState(tab.id,appState.monsterMode,appState.device,appState.nuke);

  executeInTab(tab.id, (p)=>{
      window.__omfParams=p;
      const media=document.querySelector('video, audio');
      if (!media) return;

      if (window.__omfCtx&&window.__omfCtx.state!=='closed'&&window.__omfVideo!==media) {
        window.__omfCtx.close();window.__omfCtx=null;
      }

      if (!window.__omfAdKiller) {
        window.__omfAdKiller=setInterval(()=>{
          const isAd=document.querySelector('.ad-showing,.ad-interrupting');
          if (isAd) {
            if(window.__omfGain1)window.__omfGain1.gain.value=0;
            media.playbackRate=16;media.muted=true;
            document.querySelector('.ytp-ad-skip-button,.ytp-skip-ad-button')?.click();
          } else {media.muted=false;}
        },300);
      }

      if (!window.__omfCtx) {
        window.__omfVideo=media;
        const ctx=new AudioContext();window.__omfCtx=ctx;

        const src=ctx.createMediaElementSource(media);
        const splitter=ctx.createChannelSplitter(2);
        const merger=ctx.createChannelMerger(2);
        const kL=ctx.createGain();kL.gain.value=0;
        const kR=ctx.createGain();kR.gain.value=0;
        const nL=ctx.createGain();nL.gain.value=1;
        const nR=ctx.createGain();nR.gain.value=1;
        window.__omfKL=kL;window.__omfKR=kR;window.__omfNL=nL;window.__omfNR=nR;
        src.connect(splitter);
        splitter.connect(nL,0);splitter.connect(nR,1);
        splitter.connect(kL,0);splitter.connect(kR,1);
        kL.connect(merger,0,0);kR.connect(merger,0,0);
        kL.connect(merger,0,1);kR.connect(merger,0,1);
        nL.connect(merger,0,0);nR.connect(merger,0,1);

        const bEQ=ctx.createBiquadFilter();bEQ.type='lowshelf';bEQ.frequency.value=200;
        const tEQ=ctx.createBiquadFilter();tEQ.type='highshelf';tEQ.frequency.value=4000;
        
        const underFilter = ctx.createBiquadFilter();
        const megaFilter = ctx.createBiquadFilter();
        const lofiHP = ctx.createBiquadFilter();
        const lofiLP = ctx.createBiquadFilter();
        window.__omfUnder = underFilter; window.__omfMega = megaFilter;
        window.__omfLofiHP = lofiHP; window.__omfLofiLP = lofiLP;

        const panner3D = ctx.createPanner();
        panner3D.panningModel = 'HRTF';
        panner3D.distanceModel = 'inverse';
        panner3D.refDistance = 1;
        panner3D.maxDistance = 10000;
        panner3D.rolloffFactor = 1;
        window.__omf3DPanner = panner3D;

        const pan=ctx.createStereoPanner();

        const g1=ctx.createGain(); 
        const g2=ctx.createGain(); 
        const g3=ctx.createGain(); 
        g1.gain.value=1;g2.gain.value=1;g3.gain.value=1;
        window.__omfGain1=g1;window.__omfGain2=g2;window.__omfGain3=g3;

        const distortion=ctx.createWaveShaper();
        window.__omfDistortion=distortion;

        const ana=ctx.createAnalyser();ana.fftSize=64;
        window.__omfBEQ=bEQ;window.__omfTEQ=tEQ;window.__omfPan=pan;window.__omfAnalyser=ana;

        merger.connect(bEQ);bEQ.connect(tEQ);
        tEQ.connect(underFilter);underFilter.connect(megaFilter);
        megaFilter.connect(lofiHP);lofiHP.connect(lofiLP);
        lofiLP.connect(panner3D);panner3D.connect(pan);
        pan.connect(g1);g1.connect(g2);g2.connect(g3);
        g3.connect(distortion);distortion.connect(ana);ana.connect(ctx.destination);

        setInterval(()=>{
          const d=new Uint8Array(ana.frequencyBinCount);
          ana.getByteFrequencyData(d);
          chrome.runtime.sendMessage({type:"AUDIO_VISUALIZER_DATA",data:Array.from(d)});
        },50);

        if (!window.__omfDynamicLoop) {
          window.__omfDynamicAngle = 0;
          window.__omfDynamicLoop = setInterval(() => {
            if (!window.__omfParams || !window.__omf3DPanner || !window.__omfPan) return;
            const pr = window.__omfParams;
            const p3 = window.__omf3DPanner;
            const sp = window.__omfPan;
            
            if (pr.eightD) {
              window.__omfDynamicAngle += 0.035;
              p3.positionX.value = Math.sin(window.__omfDynamicAngle) * 3.5;
              p3.positionZ.value = Math.cos(window.__omfDynamicAngle) * 3.5;
              p3.positionY.value = Math.sin(window.__omfDynamicAngle * 0.5) * 0.8;
              sp.pan.value = Math.sin(window.__omfDynamicAngle) * 0.7;
            } 
            else if (pr.spatial) {
              p3.positionX.value = 0;
              p3.positionY.value = 0.5;
              p3.positionZ.value = -3.0;
              sp.pan.value = 0;
            } 
            else {
              p3.positionX.value = 0;
              p3.positionY.value = 0;
              p3.positionZ.value = 0;
              
              if (pr.compressor) {
                sp.pan.value = Math.sin(Date.now() / 200) * 0.8;
              } else if (pr.echo || pr.concert) {
                sp.pan.value = Math.sin(Date.now() / 400) * 0.5;
              } else {
                sp.pan.value = 0;
              }
            }
            
            if (pr.tremolo && window.__omfGain1) {
              const baseG = p.nuke ? 10000 : Math.cbrt(pr.volume || 1);
              window.__omfGain1.gain.value = Math.max(0.2, Math.abs(Math.sin(Date.now() / 150)) * baseG * 1.5);
            }
          }, 20); 
        }
      }

      const ctx2=window.__omfCtx;
      if(ctx2.state==='suspended')ctx2.resume();

      const isAd=document.querySelector('.ad-showing,.ad-interrupting');
      if(!isAd){
        const vol = p.volume;

        window.__omfUnder.type = p.under ? 'lowpass' : 'allpass';
        window.__omfUnder.frequency.value = p.under ? 300 : 20000;

        window.__omfMega.type = p.mega ? 'bandpass' : 'allpass';
        window.__omfMega.frequency.value = 1500;
        window.__omfMega.Q.value = p.mega ? 3 : 0.0001;

        window.__omfLofiHP.type = p.lofi ? 'highpass' : 'allpass';
        window.__omfLofiHP.frequency.value = p.lofi ? 500 : 0;
        window.__omfLofiLP.type = p.lofi ? 'lowpass' : 'allpass';
        window.__omfLofiLP.frequency.value = p.lofi ? 3000 : 20000;

        // 🔥 NÜKLEER İÇİN DİSTORSİYON ZİRVEDE! (1 Milyon)
        const distAmount = p.nuke ? 1000000 : (p.rape ? 5000 : Math.max(0, (vol - 5) * 4));
        const curve = makeDistortionCurve(Math.min(distAmount, 1000000));
        window.__omfDistortion.curve = curve;
        window.__omfDistortion.oversample = (vol > 50 || p.rape || p.nuke) ? '4x' : 'none';

        // 🔥 FRENSİZ GAIN (SES KAZANCI) PATLAMASI
        let g1 = Math.cbrt(vol);
        let g2 = Math.cbrt(vol);
        let g3 = Math.max(1, vol / (g1 * g2));

        if (p.nuke) {
          // Sistem güvenliğini (cbrt) atlıyoruz, doğrudan çıldırmış kazanç veriyoruz!
          g1 = 10000;
          g2 = 10000;
          g3 = 10000;
        }

        window.__omfGain1.gain.setTargetAtTime(g1, ctx2.currentTime, 0.01);
        window.__omfGain2.gain.setTargetAtTime(g2, ctx2.currentTime, 0.01);
        window.__omfGain3.gain.setTargetAtTime(g3, ctx2.currentTime, 0.01);

        let bassVal = p.sub ? p.bass + 25 : p.bass;
        if (vol > 50000 || p.nuke) {       
          bassVal = 0; // Aşırı seste bası kesiyoruz ki tizler patlasın
        } else if (vol > 500) {  
          bassVal = p.bass * (1 - (vol-500)/49500);
        } else if (vol > 50) {   
          bassVal = p.bass * (1 - (vol-50)/900 * 0.5);
        }
        window.__omfBEQ.gain.setTargetAtTime(bassVal,ctx2.currentTime,0.01);
        window.__omfTEQ.gain.setTargetAtTime(p.treble,ctx2.currentTime,0.01);

        if(p.karaoke){
          window.__omfNL.gain.setTargetAtTime(0,ctx2.currentTime,0.05);
          window.__omfNR.gain.setTargetAtTime(0,ctx2.currentTime,0.05);
          window.__omfKL.gain.setTargetAtTime(1,ctx2.currentTime,0.05);
          window.__omfKR.gain.setTargetAtTime(-1,ctx2.currentTime,0.05);
        } else {
          window.__omfNL.gain.setTargetAtTime(1,ctx2.currentTime,0.05);
          window.__omfNR.gain.setTargetAtTime(1,ctx2.currentTime,0.05);
          window.__omfKL.gain.setTargetAtTime(0,ctx2.currentTime,0.05);
          window.__omfKR.gain.setTargetAtTime(0,ctx2.currentTime,0.05);
        }

        let targetRate = 1.0;
        if (p.chip) targetRate = 2.0;
        else if (p.demon) targetRate = 0.5;
        else if (p.slowed) targetRate = 0.8;
        else if (p.compressor) targetRate = 1.4;
        media.playbackRate = targetRate;

        media.muted=false;
      }

      function makeDistortionCurve(amount) {
        const n=256, curve=new Float32Array(n);
        for (let i=0;i<n;i++) {
          const x=(i*2/n)-1;
          if (amount===0) { curve[i]=x; continue; }
          curve[i]=(Math.PI+amount)*x / (Math.PI + amount*Math.abs(x));
        }
        return curve;
      }
    }, [appState]);
}

function init() {
  document.getElementById('tabSesBtn').addEventListener('click',()=>showTab('ses'));
  document.getElementById('tabKorumaBtn').addEventListener('click',()=>showTab('koruma'));

  [['volume','vVal','%'],['bass','bVal','dB'],['treble','tVal','dB']].forEach(([id,vid,u]) => {
    document.getElementById(id).addEventListener('input', e=>{
      let v=parseInt(e.target.value);
      let label = v >= 1000000000 ? (v/1000000000).toFixed(1)+'Milyar' : v >= 1000000 ? (v/1000000).toFixed(1)+'M' : v >= 1000 ? (v/1000).toFixed(0)+'K' : v;
      document.getElementById(vid).innerText=label+u;
      updateEngine();
    });
  });

  [['slowBtn','slowed'],['karaBtn','karaoke'],['spatialBtn','spatial'],
   ['eightDBtn','eightD'],['compressorBtn','compressor'],['monoBtn','mono'],
   ['underBtn','under'],['megaBtn','mega'],['rapeBtn','rape'],['concertBtn','concert'],
   ['chipBtn','chip'],['demonBtn','demon'],['lofiBtn','lofi'],['subBtn','sub'],
   ['tremoloBtn','tremolo'],['echoBtn','echo'],['nukeBtn','nuke']].forEach(([id,key])=>{
    const el=document.getElementById(id);if(!el)return;
    el.addEventListener('click',e=>{
      appState[key]=!appState[key];
      e.target.classList.toggle('active');
      if(id==='compressorBtn')e.target.innerText=appState[key]?'🎪 KOMİK MOD: AÇIK':'NIGHT MODE';
      if(id==='nukeBtn')e.target.innerText=appState[key]?'💥 NÜKLEER PATLAMA AÇIK!':'☢️ NÜKLEER SES (10.000X BOOST)';
      updateEngine();
    });
  });

  document.getElementById('pcMode').addEventListener('click',e=>{
    appState.device='pc';document.getElementById('deviceText').innerText='BİLGİSAYAR (YIKIM)';
    e.target.classList.add('active');document.getElementById('boardMode').classList.remove('active');updateEngine();
  });
  document.getElementById('boardMode').addEventListener('click',e=>{
    appState.device='board';document.getElementById('deviceText').innerText='AKILLI TAHTA (DEHŞET)';
    e.target.classList.add('active');document.getElementById('pcMode').classList.remove('active');updateEngine();
  });
  document.getElementById('monsterBtn').addEventListener('click',e=>{
    appState.monsterMode=!appState.monsterMode;
    e.target.classList.toggle('active');
    e.target.innerText=appState.monsterMode?"👹 MOD: YOK EDİCİ":"👹 CANAVAR MODU: KAPALI";
    updateEngine();
  });
  document.getElementById('resetBtn').addEventListener('click',()=>location.reload());

  PROT_KEYS.forEach(key=>{
    document.getElementById('row'+key).addEventListener('click',()=>{
      protSettings[key.toLowerCase()]=!protSettings[key.toLowerCase()];
      applyProtSettings();
    });
  });

  document.getElementById('resetStatsBtn').addEventListener('click',()=>{
    chrome.storage.local.set({protectionStats:{trackers:0,ads:0,downloads:0}},loadStats);
  });

  chrome.storage.local.get(['protSettings'],(res)=>{
    if(res.protSettings)protSettings={...protSettings,...res.protSettings};
    renderProtUI();
  });
}

document.addEventListener('DOMContentLoaded',()=>{setupVisualizer();init();updateEngine();});
