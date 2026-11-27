export const statuses=["Backlog","Todo","In Progress","In Review","Done"] as const;
export type Issue={id:string;project:string;title:string;description:string;criteria:string;assignee:string;repository:string;createdAt?:string;comments?:{body:string;at:string}[];status:typeof statuses[number]};
const key="ae-work-board-v1";
export function issues():Issue[]{try{const v=JSON.parse(localStorage.getItem(key)||"[]");return Array.isArray(v)?v:[]}catch{return []}}
export function saveIssue(issue:Issue){const all=issues();const i=all.findIndex(x=>x.id===issue.id);if(i<0)all.push(issue);else all[i]=issue;localStorage.setItem(key,JSON.stringify(all))}
export function boardContext(project:string){if(!project)return "";const all=issues().filter(x=>x.project===project);return JSON.stringify({total:all.length,counts:Object.fromEntries(statuses.map(s=>[s,all.filter(x=>x.status===s).length])),issues:all.slice(0,20).map(x=>({id:x.id,title:x.title.slice(0,160),status:x.status,assignee:x.assignee,description:x.description.slice(0,240),criteria:x.criteria.slice(0,160),repository:x.repository})),truncated:all.length>20})}
