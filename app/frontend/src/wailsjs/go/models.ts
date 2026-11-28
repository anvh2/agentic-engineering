export namespace acp {
	
	export class AvailableCommandInput {
	
	
	    static createFrom(source: any = {}) {
	        return new AvailableCommandInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	
	    }
	}
	export class AvailableCommand {
	    _meta?: Record<string, any>;
	    description: string;
	    input?: AvailableCommandInput;
	    name: string;
	
	    static createFrom(source: any = {}) {
	        return new AvailableCommand(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this._meta = source["_meta"];
	        this.description = source["description"];
	        this.input = this.convertValues(source["input"], AvailableCommandInput);
	        this.name = source["name"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class Cost {
	    amount: number;
	    currency: string;
	
	    static createFrom(source: any = {}) {
	        return new Cost(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.amount = source["amount"];
	        this.currency = source["currency"];
	    }
	}
	export class SessionUsageUpdate {
	    _meta?: Record<string, any>;
	    cost?: Cost;
	    sessionUpdate: string;
	    size: number;
	    used: number;
	
	    static createFrom(source: any = {}) {
	        return new SessionUsageUpdate(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this._meta = source["_meta"];
	        this.cost = this.convertValues(source["cost"], Cost);
	        this.sessionUpdate = source["sessionUpdate"];
	        this.size = source["size"];
	        this.used = source["used"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class UnstructuredCommandInput {
	    _meta?: Record<string, any>;
	    hint: string;
	
	    static createFrom(source: any = {}) {
	        return new UnstructuredCommandInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this._meta = source["_meta"];
	        this.hint = source["hint"];
	    }
	}
	export class Usage {
	    cachedReadTokens?: number;
	    cachedWriteTokens?: number;
	    inputTokens: number;
	    outputTokens: number;
	    thoughtTokens?: number;
	    totalTokens: number;
	
	    static createFrom(source: any = {}) {
	        return new Usage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.cachedReadTokens = source["cachedReadTokens"];
	        this.cachedWriteTokens = source["cachedWriteTokens"];
	        this.inputTokens = source["inputTokens"];
	        this.outputTokens = source["outputTokens"];
	        this.thoughtTokens = source["thoughtTokens"];
	        this.totalTokens = source["totalTokens"];
	    }
	}

}

export namespace core {
	
	export class Review {
	    id: string;
	    objective_id: string;
	    reviewer: string;
	    turn_id: string;
	    verdict: string;
	    summary: string;
	    verification: string;
	    created_at: string;
	
	    static createFrom(source: any = {}) {
	        return new Review(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.objective_id = source["objective_id"];
	        this.reviewer = source["reviewer"];
	        this.turn_id = source["turn_id"];
	        this.verdict = source["verdict"];
	        this.summary = source["summary"];
	        this.verification = source["verification"];
	        this.created_at = source["created_at"];
	    }
	}
	export class Task {
	    id: string;
	    objective_id: string;
	    title: string;
	    description?: string;
	    status: string;
	    owner?: string;
	    summary?: string;
	    revision: number;
	    // Go type: time
	    updated_at: any;
	
	    static createFrom(source: any = {}) {
	        return new Task(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.objective_id = source["objective_id"];
	        this.title = source["title"];
	        this.description = source["description"];
	        this.status = source["status"];
	        this.owner = source["owner"];
	        this.summary = source["summary"];
	        this.revision = source["revision"];
	        this.updated_at = this.convertValues(source["updated_at"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace discovery {
	
	export class Status {
	    name: string;
	    path: string;
	    version: string;
	    authentication: string;
	    state: string;
	    diagnostic: string;
	
	    static createFrom(source: any = {}) {
	        return new Status(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.version = source["version"];
	        this.authentication = source["authentication"];
	        this.state = source["state"];
	        this.diagnostic = source["diagnostic"];
	    }
	}

}

export namespace issues {
	
	export class Activity {
	    seq: number;
	    at: string;
	    kind: string;
	    actor: string;
	    text: string;
	
	    static createFrom(source: any = {}) {
	        return new Activity(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.seq = source["seq"];
	        this.at = source["at"];
	        this.kind = source["kind"];
	        this.actor = source["actor"];
	        this.text = source["text"];
	    }
	}
	export class AgentRef {
	    id: string;
	    name: string;
	    handle: string;
	    role: string;
	    harness: string;
	    model: string;
	    duty: string;
	
	    static createFrom(source: any = {}) {
	        return new AgentRef(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.handle = source["handle"];
	        this.role = source["role"];
	        this.harness = source["harness"];
	        this.model = source["model"];
	        this.duty = source["duty"];
	    }
	}
	export class Command {
	    turnId: string;
	    duty: string;
	    agentName: string;
	    command: string;
	    exitCode?: number;
	    failed: boolean;
	    background: boolean;
	    test: boolean;
	    output: string;
	    at: string;
	
	    static createFrom(source: any = {}) {
	        return new Command(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.turnId = source["turnId"];
	        this.duty = source["duty"];
	        this.agentName = source["agentName"];
	        this.command = source["command"];
	        this.exitCode = source["exitCode"];
	        this.failed = source["failed"];
	        this.background = source["background"];
	        this.test = source["test"];
	        this.output = source["output"];
	        this.at = source["at"];
	    }
	}
	export class CommentResult {
	    delivery: string;
	    recipients: string[];
	
	    static createFrom(source: any = {}) {
	        return new CommentResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.delivery = source["delivery"];
	        this.recipients = source["recipients"];
	    }
	}
	export class Message {
	    seq: number;
	    from: string;
	    to: string;
	    body: string;
	    at: string;
	
	    static createFrom(source: any = {}) {
	        return new Message(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.seq = source["seq"];
	        this.from = source["from"];
	        this.to = source["to"];
	        this.body = source["body"];
	        this.at = source["at"];
	    }
	}
	export class Usage {
	    model: string;
	    inputTokens?: number;
	    cacheRead?: number;
	    cacheWrite?: number;
	    outputTokens?: number;
	    costUsd?: number;
	
	    static createFrom(source: any = {}) {
	        return new Usage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.model = source["model"];
	        this.inputTokens = source["inputTokens"];
	        this.cacheRead = source["cacheRead"];
	        this.cacheWrite = source["cacheWrite"];
	        this.outputTokens = source["outputTokens"];
	        this.costUsd = source["costUsd"];
	    }
	}
	export class Run {
	    turnId: string;
	    duty: string;
	    agentId: string;
	    agentName: string;
	    harness: string;
	    purpose: string;
	    state: string;
	    startedAt: string;
	    endedAt: string;
	    error: string;
	    finalText: string;
	    events: number;
	    toolFailures: number;
	    usage: Usage[];
	    knowledgeVersion: string;
	    knowledgeRevision: string;
	    evidencePath: string;
	    evidenceSha256: string;
	    nativeSessionId: string;
	
	    static createFrom(source: any = {}) {
	        return new Run(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.turnId = source["turnId"];
	        this.duty = source["duty"];
	        this.agentId = source["agentId"];
	        this.agentName = source["agentName"];
	        this.harness = source["harness"];
	        this.purpose = source["purpose"];
	        this.state = source["state"];
	        this.startedAt = source["startedAt"];
	        this.endedAt = source["endedAt"];
	        this.error = source["error"];
	        this.finalText = source["finalText"];
	        this.events = source["events"];
	        this.toolFailures = source["toolFailures"];
	        this.usage = this.convertValues(source["usage"], Usage);
	        this.knowledgeVersion = source["knowledgeVersion"];
	        this.knowledgeRevision = source["knowledgeRevision"];
	        this.evidencePath = source["evidencePath"];
	        this.evidenceSha256 = source["evidenceSha256"];
	        this.nativeSessionId = source["nativeSessionId"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class RepositoryState {
	    id: string;
	    name: string;
	    path: string;
	    baseCommit: string;
	    assigneeDir: string;
	    reviewerDir: string;
	    snapshotCommit: string;
	    files: workspace.File[];
	    patch: string;
	    patchTruncated: boolean;
	    patchSha256: string;
	    patchPath: string;
	
	    static createFrom(source: any = {}) {
	        return new RepositoryState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.path = source["path"];
	        this.baseCommit = source["baseCommit"];
	        this.assigneeDir = source["assigneeDir"];
	        this.reviewerDir = source["reviewerDir"];
	        this.snapshotCommit = source["snapshotCommit"];
	        this.files = this.convertValues(source["files"], workspace.File);
	        this.patch = source["patch"];
	        this.patchTruncated = source["patchTruncated"];
	        this.patchSha256 = source["patchSha256"];
	        this.patchPath = source["patchPath"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Execution {
	    issueId: string;
	    issueKey: string;
	    projectId: string;
	    title: string;
	    phase: string;
	    active: boolean;
	    detail: string;
	    error: string;
	    attempt: number;
	    reviewRounds: number;
	    maxReviewRounds: number;
	    pendingComments: number;
	    objectiveId: string;
	    assignee: AgentRef;
	    reviewer: AgentRef;
	    repositories: RepositoryState[];
	    runs: Run[];
	    commands: Command[];
	    activity: Activity[];
	    messages: Message[];
	    reviews: core.Review[];
	    tasks: core.Task[];
	    approvedReview: string;
	    acceptedAt: string;
	    acceptNote: string;
	    updatedAt: string;
	
	    static createFrom(source: any = {}) {
	        return new Execution(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.issueId = source["issueId"];
	        this.issueKey = source["issueKey"];
	        this.projectId = source["projectId"];
	        this.title = source["title"];
	        this.phase = source["phase"];
	        this.active = source["active"];
	        this.detail = source["detail"];
	        this.error = source["error"];
	        this.attempt = source["attempt"];
	        this.reviewRounds = source["reviewRounds"];
	        this.maxReviewRounds = source["maxReviewRounds"];
	        this.pendingComments = source["pendingComments"];
	        this.objectiveId = source["objectiveId"];
	        this.assignee = this.convertValues(source["assignee"], AgentRef);
	        this.reviewer = this.convertValues(source["reviewer"], AgentRef);
	        this.repositories = this.convertValues(source["repositories"], RepositoryState);
	        this.runs = this.convertValues(source["runs"], Run);
	        this.commands = this.convertValues(source["commands"], Command);
	        this.activity = this.convertValues(source["activity"], Activity);
	        this.messages = this.convertValues(source["messages"], Message);
	        this.reviews = this.convertValues(source["reviews"], core.Review);
	        this.tasks = this.convertValues(source["tasks"], core.Task);
	        this.approvedReview = source["approvedReview"];
	        this.acceptedAt = source["acceptedAt"];
	        this.acceptNote = source["acceptNote"];
	        this.updatedAt = source["updatedAt"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	
	export class StartRequest {
	    issueId: string;
	    issueKey: string;
	    projectId: string;
	    projectName: string;
	    title: string;
	    description: string;
	    acceptanceCriteria: string;
	    assigneeId: string;
	    reviewerId: string;
	    repositories: workspace.Repository[];
	    comments: string[];
	
	    static createFrom(source: any = {}) {
	        return new StartRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.issueId = source["issueId"];
	        this.issueKey = source["issueKey"];
	        this.projectId = source["projectId"];
	        this.projectName = source["projectName"];
	        this.title = source["title"];
	        this.description = source["description"];
	        this.acceptanceCriteria = source["acceptanceCriteria"];
	        this.assigneeId = source["assigneeId"];
	        this.reviewerId = source["reviewerId"];
	        this.repositories = this.convertValues(source["repositories"], workspace.Repository);
	        this.comments = source["comments"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace main {
	
	export class KnowledgeTraceEvent {
	    runId?: string;
	    agentId?: string;
	    at?: string;
	    kind: string;
	    documentId?: string;
	    status?: string;
	    reason?: string;
	    sha256?: string;
	    estimatedTokens?: number;
	    inputTokens?: number;
	    outputTokens?: number;
	    cacheReadTokens?: number;
	    cacheWriteTokens?: number;
	
	    static createFrom(source: any = {}) {
	        return new KnowledgeTraceEvent(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.runId = source["runId"];
	        this.agentId = source["agentId"];
	        this.at = source["at"];
	        this.kind = source["kind"];
	        this.documentId = source["documentId"];
	        this.status = source["status"];
	        this.reason = source["reason"];
	        this.sha256 = source["sha256"];
	        this.estimatedTokens = source["estimatedTokens"];
	        this.inputTokens = source["inputTokens"];
	        this.outputTokens = source["outputTokens"];
	        this.cacheReadTokens = source["cacheReadTokens"];
	        this.cacheWriteTokens = source["cacheWriteTokens"];
	    }
	}
	export class TokenUsage {
	    inputTokens: number;
	    outputTokens: number;
	    cacheReadTokens?: number;
	    cacheWriteTokens?: number;
	    provider: string;
	    scope?: string;
	
	    static createFrom(source: any = {}) {
	        return new TokenUsage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.inputTokens = source["inputTokens"];
	        this.outputTokens = source["outputTokens"];
	        this.cacheReadTokens = source["cacheReadTokens"];
	        this.cacheWriteTokens = source["cacheWriteTokens"];
	        this.provider = source["provider"];
	        this.scope = source["scope"];
	    }
	}
	export class ConsoleResult {
	    output: string;
	    error: string;
	    usage?: TokenUsage;
	    runId?: string;
	    estimatedContextTokens?: number;
	    knowledgeEvents?: KnowledgeTraceEvent[];
	    sessionId?: string;
	    sessionReused?: boolean;
	    commands: acp.AvailableCommand[];
	    acpUsage?: acp.Usage;
	    acpContext?: acp.SessionUsageUpdate;
	
	    static createFrom(source: any = {}) {
	        return new ConsoleResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.output = source["output"];
	        this.error = source["error"];
	        this.usage = this.convertValues(source["usage"], TokenUsage);
	        this.runId = source["runId"];
	        this.estimatedContextTokens = source["estimatedContextTokens"];
	        this.knowledgeEvents = this.convertValues(source["knowledgeEvents"], KnowledgeTraceEvent);
	        this.sessionId = source["sessionId"];
	        this.sessionReused = source["sessionReused"];
	        this.commands = this.convertValues(source["commands"], acp.AvailableCommand);
	        this.acpUsage = this.convertValues(source["acpUsage"], acp.Usage);
	        this.acpContext = this.convertValues(source["acpContext"], acp.SessionUsageUpdate);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class GitRef {
	    name: string;
	    kind: string;
	
	    static createFrom(source: any = {}) {
	        return new GitRef(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.kind = source["kind"];
	    }
	}
	export class KnowledgeContextRequest {
	    repositoryDir: string;
	    agentId: string;
	    root: string;
	    role: string;
	    languages: string[];
	    assigned: string[];
	    task: string;
	
	    static createFrom(source: any = {}) {
	        return new KnowledgeContextRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.repositoryDir = source["repositoryDir"];
	        this.agentId = source["agentId"];
	        this.root = source["root"];
	        this.role = source["role"];
	        this.languages = source["languages"];
	        this.assigned = source["assigned"];
	        this.task = source["task"];
	    }
	}
	export class KnowledgeEntry {
	    group?: string;
	    capabilities?: string[];
	    id: string;
	    title?: string;
	    description?: string;
	    path: string;
	    kind: string;
	    load?: string;
	    status?: string;
	    roles?: string[];
	    languages?: string[];
	    sha256?: string;
	    bytes: number;
	    tokens: number;
	
	    static createFrom(source: any = {}) {
	        return new KnowledgeEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.group = source["group"];
	        this.capabilities = source["capabilities"];
	        this.id = source["id"];
	        this.title = source["title"];
	        this.description = source["description"];
	        this.path = source["path"];
	        this.kind = source["kind"];
	        this.load = source["load"];
	        this.status = source["status"];
	        this.roles = source["roles"];
	        this.languages = source["languages"];
	        this.sha256 = source["sha256"];
	        this.bytes = source["bytes"];
	        this.tokens = source["tokens"];
	    }
	}
	export class KnowledgeGroup {
	    id: string;
	    title: string;
	
	    static createFrom(source: any = {}) {
	        return new KnowledgeGroup(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	    }
	}
	export class KnowledgePack {
	    groups?: KnowledgeGroup[];
	    schemaVersion: number;
	    id: string;
	    version: string;
	    status: string;
	    language: string;
	    entries: KnowledgeEntry[];
	    root: string;
	    ref: string;
	    repository?: string;
	    manifest?: string;
	
	    static createFrom(source: any = {}) {
	        return new KnowledgePack(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.groups = this.convertValues(source["groups"], KnowledgeGroup);
	        this.schemaVersion = source["schemaVersion"];
	        this.id = source["id"];
	        this.version = source["version"];
	        this.status = source["status"];
	        this.language = source["language"];
	        this.entries = this.convertValues(source["entries"], KnowledgeEntry);
	        this.root = source["root"];
	        this.ref = source["ref"];
	        this.repository = source["repository"];
	        this.manifest = source["manifest"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class TeamSync {
	    agents: team.Profile[];
	    harnessPaths: Record<string, string>;
	
	    static createFrom(source: any = {}) {
	        return new TeamSync(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.agents = this.convertValues(source["agents"], team.Profile);
	        this.harnessPaths = source["harnessPaths"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace team {
	
	export class Profile {
	    id: string;
	    name: string;
	    handle: string;
	    role: string;
	    harness: string;
	    model: string;
	    knowledgeRoot: string;
	    languages: string[];
	    assigned: string[];
	
	    static createFrom(source: any = {}) {
	        return new Profile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.handle = source["handle"];
	        this.role = source["role"];
	        this.harness = source["harness"];
	        this.model = source["model"];
	        this.knowledgeRoot = source["knowledgeRoot"];
	        this.languages = source["languages"];
	        this.assigned = source["assigned"];
	    }
	}
	export class Rejection {
	    id: string;
	    reason: string;
	
	    static createFrom(source: any = {}) {
	        return new Rejection(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.reason = source["reason"];
	    }
	}

}

export namespace workspace {
	
	export class File {
	    path: string;
	    status: string;
	    added: number;
	    deleted: number;
	
	    static createFrom(source: any = {}) {
	        return new File(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.status = source["status"];
	        this.added = source["added"];
	        this.deleted = source["deleted"];
	    }
	}
	export class Repository {
	    id: string;
	    name: string;
	    path: string;
	
	    static createFrom(source: any = {}) {
	        return new Repository(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.path = source["path"];
	    }
	}

}

