import { type ApLogger } from '@activepieces/server-utils'
import { AgentPieceTool, FlowActionType, flowStructureUtil, FlowTriggerType, FlowVersion, PiecePackage, Step, tryCatch, WorkerToApiContract } from '@activepieces/shared'
import { CodeArtifact } from '../../cache/code/code-builder'
import { pieceCache, PieceNotFoundError } from '../../cache/pieces/piece-cache'
import { provisioner } from '../../cache/provisioner'

export async function provisionFlowPieces(params: {
    flowVersion: FlowVersion
    platformId: string
    flowId: string
    projectId: string
    log: ApLogger
    apiClient: WorkerToApiContract
}): Promise<boolean> {
    const { flowVersion, platformId, flowId, projectId, log, apiClient } = params
    const { error } = await tryCatch(async () => {
        const pieces = await extractPiecePackages(flowVersion, platformId, log, apiClient)
        const codeSteps = extractCodeArtifacts(flowVersion)
        await provisioner(log, apiClient).provision({ pieces, codeSteps })
    })
    if (error) {
        if (!(error instanceof PieceNotFoundError)) {
            throw error
        }
        log.warn({ error: String(error), flow: { id: flowId } }, 'Flow disabled due to missing piece')
        const { error: disableError } = await tryCatch(
            () => apiClient.disableFlow({ flowId, projectId }),
        )
        if (disableError) {
            log.error({ error: String(disableError), flow: { id: flowId } }, 'Failed to disable flow after missing piece')
        }
        return false
    }
    return true
}

export async function extractPiecePackages(flowVersion: FlowVersion, platformId: string, log: ApLogger, apiClient: WorkerToApiContract): Promise<PiecePackage[]> {
    const allSteps = flowStructureUtil.getAllSteps(flowVersion.trigger)

    const stepPieceRefs = allSteps
        .filter((step) => step.type === FlowActionType.PIECE || step.type === FlowTriggerType.PIECE)
        .map((step) => ({ pieceName: step.settings.pieceName, pieceVersion: step.settings.pieceVersion }))

    const agentToolPieceRefs = allSteps.flatMap(extractAgentToolPieceRefs)

    const uniquePieceRefs = dedupePieceRefs([...stepPieceRefs, ...agentToolPieceRefs])

    return Promise.all(
        uniquePieceRefs.map((ref) =>
            pieceCache(log, apiClient).getPiece({
                pieceName: ref.pieceName,
                pieceVersion: ref.pieceVersion,
                platformId,
            }),
        ),
    )
}

export function extractCodeArtifacts(flowVersion: FlowVersion): CodeArtifact[] {
    return flowStructureUtil.getAllSteps(flowVersion.trigger)
        .filter((step) => step.type === FlowActionType.CODE)
        .map((step) => ({
            name: step.name,
            sourceCode: step.settings.sourceCode,
            flowVersionId: flowVersion.id,
            flowVersionState: flowVersion.state,
        }))
}

function extractAgentToolPieceRefs(step: Step): PieceRef[] {
    if (step.type !== FlowActionType.PIECE) {
        return []
    }
    const agentTools = step.settings.input['agentTools']
    if (!Array.isArray(agentTools)) {
        return []
    }
    return agentTools.flatMap((tool: unknown) => {
        const parsed = AgentPieceTool.safeParse(tool)
        if (!parsed.success) {
            return []
        }
        return [{
            pieceName: parsed.data.pieceMetadata.pieceName,
            pieceVersion: parsed.data.pieceMetadata.pieceVersion,
        }]
    })
}

function dedupePieceRefs(refs: PieceRef[]): PieceRef[] {
    const byKey = new Map<string, PieceRef>()
    for (const ref of refs) {
        byKey.set(`${ref.pieceName}@${ref.pieceVersion}`, ref)
    }
    return [...byKey.values()]
}

type PieceRef = {
    pieceName: string
    pieceVersion: string
}
