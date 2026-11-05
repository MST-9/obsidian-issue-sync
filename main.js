const L=(()=>{const module={exports:{}};
// Pure helpers (no Obsidian API) so they can be tested in node.
const PUB = {"kty":"EC","crv":"P-256","x":"x2cRxOWYCS3xwo0umZ7hhBpst5HD9pAKiHcRVghMC7I","y":"sePZYC_6l7tjj76wZQrkEjTMoxOqHYnqVuf-6ebkff0"};
function b64u(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';const r=atob(s);const u=new Uint8Array(r.length);for(let i=0;i<r.length;i++)u[i]=r.charCodeAt(i);return u;}
async function verifyLicense(key, subtle){
  try{
    const p=String(key||'').trim().split('.'); if(p.length!==2) return null;
    const k=await subtle.importKey('jwk',PUB,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
    const ok=await subtle.verify({name:'ECDSA',hash:'SHA-256'},k,b64u(p[1]),b64u(p[0]));
    return ok? new TextDecoder().decode(b64u(p[0])) : null;
  }catch(e){return null;}
}
function parseRepo(s){const m=String(s||'').trim().replace(/^https?:\/\/github\.com\//,'').match(/^([\w.-]+)\/([\w.-]+)$/);return m?{owner:m[1],repo:m[2]}:null;}
function safeName(s){return String(s).replace(/[\\/:*?"<>|#^\[\]]/g,' ').replace(/\s+/g,' ').trim().slice(0,80)||'untitled';}
function normGithub(i){return {id:'GH-'+i.number,title:i.title,state:i.state,url:i.html_url,labels:(i.labels||[]).map(l=>l.name||l),assignee:i.assignee?i.assignee.login:'',updated:(i.updated_at||'').slice(0,10),body:i.body||''};}
function normLinear(i){return {id:i.identifier,title:i.title,state:(i.state&&i.state.name)||'',url:i.url,labels:((i.labels&&i.labels.nodes)||[]).map(l=>l.name),assignee:i.assignee?i.assignee.name:'',updated:(i.updatedAt||'').slice(0,10),body:i.description||''};}
function esc(s){return String(s).replace(/\|/g,'\\|').replace(/\n/g,' ');}
function renderTable(issues, source, now){
  const lines=['---','issue-sync: '+source,'synced: '+now,'count: '+issues.length,'---','','| ID | Title | State | Labels | Assignee | Updated |','|---|---|---|---|---|---|'];
  for(const i of issues) lines.push('| ['+esc(i.id)+']('+i.url+') | '+esc(i.title)+' | '+esc(i.state)+' | '+esc(i.labels.join(', '))+' | '+esc(i.assignee)+' | '+i.updated+' |');
  return lines.join('\n')+'\n';
}
function renderIssueNote(i, source){
  return ['---','issue-id: '+i.id,'source: '+source,'state: '+i.state,'url: '+i.url,'labels: ['+i.labels.map(l=>JSON.stringify(l)).join(', ')+']','assignee: '+JSON.stringify(i.assignee),'---','','# '+i.id+' '+i.title,'',i.body,''].join('\n');
}
const LINEAR_QUERY='query($first:Int!){issues(first:$first,orderBy:updatedAt){nodes{identifier title url updatedAt description state{name} assignee{name} labels{nodes{name}}}}}';
module.exports={verifyLicense,parseRepo,safeName,normGithub,normLinear,renderTable,renderIssueNote,LINEAR_QUERY,b64u};
return module.exports;})();
const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, normalizePath } = require('obsidian');
const DEFAULTS = { repo:'', ghToken:'', linearKey:'', license:'', folder:'Issues', limit:50 };

module.exports = class IssueSync extends Plugin {
  async onload(){
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.pro = false; await this.checkLicense();
    this.addSettingTab(new Tab(this.app, this));
    this.addCommand({id:'sync-github', name:'Sync GitHub issues into table note', callback:()=>this.run(()=>this.syncGithub())});
    this.addCommand({id:'sync-linear', name:'Sync Linear issues into table note (Pro)', callback:()=>this.run(()=>this.syncLinear())});
    this.addCommand({id:'notes-github', name:'Create one note per GitHub issue (Pro)', callback:()=>this.run(()=>this.perNote('github'))});
    this.addCommand({id:'notes-linear', name:'Create one note per Linear issue (Pro)', callback:()=>this.run(()=>this.perNote('linear'))});
  }
  async checkLicense(){ this.licensee = await L.verifyLicense(this.settings.license, window.crypto.subtle); this.pro = !!this.licensee; }
  needPro(){ if(!this.pro){ new Notice('Issue Sync: this is a Pro feature. Enter a license key in the plugin settings.'); return true;} return false; }
  async run(fn){ try{ await fn(); }catch(e){ new Notice('Issue Sync error: '+(e && e.message || e)); console.error(e);} }
  async ghIssues(){
    const r=L.parseRepo(this.settings.repo); if(!r) throw new Error('Set a repository like owner/name in settings.');
    const h={Accept:'application/vnd.github+json'}; if(this.settings.ghToken) h.Authorization='Bearer '+this.settings.ghToken;
    const res=await requestUrl({url:`https://api.github.com/repos/${r.owner}/${r.repo}/issues?state=all&per_page=${Math.min(+this.settings.limit||50,100)}`,headers:h});
    return res.json.filter(i=>!i.pull_request).map(L.normGithub);
  }
  async linIssues(){
    if(!this.settings.linearKey) throw new Error('Set a Linear API key in settings.');
    const res=await requestUrl({url:'https://api.linear.app/graphql',method:'POST',headers:{'Content-Type':'application/json',Authorization:this.settings.linearKey},body:JSON.stringify({query:L.LINEAR_QUERY,variables:{first:Math.min(+this.settings.limit||50,100)}})});
    if(res.json.errors) throw new Error(res.json.errors[0].message);
    return res.json.data.issues.nodes.map(L.normLinear);
  }
  async write(path, text){
    path=normalizePath(path); const dir=path.split('/').slice(0,-1).join('/');
    if(dir && !(await this.app.vault.adapter.exists(dir))) await this.app.vault.createFolder(dir);
    const f=this.app.vault.getAbstractFileByPath(path);
    if(f) await this.app.vault.modify(f,text); else await this.app.vault.create(path,text);
  }
  async syncGithub(){ const is=await this.ghIssues(); await this.write(`${this.settings.folder}/GitHub issues.md`, L.renderTable(is,'github:'+this.settings.repo,new Date().toISOString())); new Notice(`Issue Sync: ${is.length} GitHub issues synced.`); }
  async syncLinear(){ if(this.needPro()) return; const is=await this.linIssues(); await this.write(`${this.settings.folder}/Linear issues.md`, L.renderTable(is,'linear',new Date().toISOString())); new Notice(`Issue Sync: ${is.length} Linear issues synced.`); }
  async perNote(src){ if(this.needPro()) return; const is= src==='github'? await this.ghIssues(): await this.linIssues();
    for(const i of is) await this.write(`${this.settings.folder}/${src}/${L.safeName(i.id+' '+i.title)}.md`, L.renderIssueNote(i,src));
    new Notice(`Issue Sync: ${is.length} notes written.`); }
};

class Tab extends PluginSettingTab {
  constructor(app,p){super(app,p);this.p=p;}
  display(){
    const c=this.containerEl; c.empty(); const s=this.p.settings; const save=async()=>{await this.p.saveData(s);};
    c.createEl('h2',{text:'Issue Sync'});
    c.createEl('p',{text: this.p.pro? 'Pro active for '+this.p.licensee : 'Free (GitHub table). Pro adds Linear sync and one note per issue.'});
    const add=(name,desc,key,ph,extra)=>new Setting(c).setName(name).setDesc(desc).addText(t=>{t.setPlaceholder(ph).setValue(String(s[key])).onChange(async v=>{s[key]=v.trim(); await save(); if(key==='license'){await this.p.checkLicense();} });});
    add('GitHub repository','owner/name (public repos need no token)','repo','owner/name');
    add('GitHub token (optional)','For private repos or higher rate limits. Stored in plugin data.json.','ghToken','ghp_...');
    add('Linear API key (Pro)','Personal API key from Linear > Settings > API.','linearKey','lin_api_...');
    add('Output folder','Where notes are written','folder','Issues');
    add('Issue limit','Max issues per sync (1-100)','limit','50');
    add('License key (Pro)','Paste the key you received after purchase. Verified offline.','license','key');
  }
}
