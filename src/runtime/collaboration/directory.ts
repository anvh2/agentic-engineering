import { participantIdentitySchema, CollaborationError, type ParticipantIdentity } from './types.ts';

/**
 * The configured agent identities a discussion may attribute anything to. It is built by the caller from configuration
 * (src/lead/collaboration/roster.ts) and is the only source of an author's role and kind: a message names its author by id
 * and the store copies the identity from here, so no caller can claim a role it was not configured with.
 */
export class ParticipantDirectory {
  private readonly byId = new Map<string, ParticipantIdentity>();

  constructor(identities: readonly ParticipantIdentity[]) {
    for (const raw of identities) {
      const parsed = participantIdentitySchema.safeParse(raw);
      if (!parsed.success) throw new CollaborationError('invalid', `agent identity ${JSON.stringify((raw as { id?: unknown })?.id)}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      if (this.byId.has(parsed.data.id)) throw new CollaborationError('duplicate', `agent identity ${parsed.data.id} is configured twice`);
      this.byId.set(parsed.data.id, Object.freeze({ ...parsed.data }));
    }
  }

  get(id: string): ParticipantIdentity | undefined {
    return this.byId.get(id);
  }

  require(id: string): ParticipantIdentity {
    const a = this.byId.get(id);
    if (!a) throw new CollaborationError('unauthorized', `${JSON.stringify(id)} is not a configured agent identity`);
    return a;
  }

  list(): ParticipantIdentity[] {
    return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}
