// Deterministic contract fake for the reasoning port. It runs a caller-supplied script and labels every turn
// CONTRACT_FAKE; runs it produces are recorded with result origin CONTRACT_FAKE and ledger trust CONTRACT_FAKE, so a
// fake result can never be presented as a real SERV run. Requests are retained for inspection by tests.
import type { AdapterCapabilityAssessment } from '@uptimebuyer/contracts';
import type { ReasonerPort, ReasonerRequest, ReasonerTurn } from './port.js';

export type FakeScript = (request: ReasonerRequest, turn: number) => ReasonerTurn | Promise<ReasonerTurn>;

export class ContractFakeReasoner implements ReasonerPort {
  readonly adapter = 'CONTRACT_FAKE' as const;
  readonly requests: ReasonerRequest[] = [];
  constructor(
    private readonly script: FakeScript,
    private readonly capability: AdapterCapabilityAssessment = { kind: 'ELIGIBLE' },
  ) {}

  assess(): AdapterCapabilityAssessment {
    return this.capability;
  }

  async complete(request: ReasonerRequest): Promise<ReasonerTurn> {
    this.requests.push(structuredClone(request));
    const turn = await this.script(request, this.requests.length);
    return {
      ...turn,
      model: { adapter: 'CONTRACT_FAKE', modelId: 'contract-fake-reasoner', modelVersion: '1', responseId: null },
      usage: { promptTokens: null, completionTokens: null },
    };
  }
}
