export const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
export const cash=(n)=>"$"+Number(n||0).toFixed(2);
export const sum=(records,key)=>records.reduce((n,r)=>n+Number(r[key]||0),0);
export const pill=(name)=>`<span class="pill" data-status="${escapeHTML(name)}">${escapeHTML(name)}</span>`;
export const action=(text,attr,primary=false)=>`<button class="${primary?"primary":""}" ${attr}>${escapeHTML(text)}</button>`;
export const heading=(title,subtitle,actions="")=>`<div class="heading"><div><h1>${escapeHTML(title)}</h1><small>${escapeHTML(subtitle)}</small></div><div class="heading-actions">${actions}</div></div>`;
export const panel=(title,body)=>`<section class="panel"><h2>${escapeHTML(title)}</h2>${body}</section>`;
export const line=(left,right="")=>`<div class="line between"><span>${left}</span><span>${right}</span></div>`;
