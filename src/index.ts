import {
    createConnector,
    readConfig,
    logger,
    ConnectorError,
    StdTestConnectionHandler,
    StdEntitlementListHandler,
    StdAccountCreateHandler,
    StdAccountUpdateHandler,
} from '@sailpoint/connector-sdk'
import { Config } from './model/config'
import { ISCClient } from './isc-client'
import { AccessRequestType, EntitlementDocument, Index } from 'sailpoint-api-client'
import { Entitlement } from './model/entitlement'
import { Account } from './model/account'

// Connector must be exported as module property named connector
export const connector = async () => {
    const config: Config = await readConfig()

    // Use the vendor SDK, or implement own client as necessary, to initialize a client
    const isc = new ISCClient(config)

    const createAccessRequest = async (identity: string, entitlements: string[], requestType: AccessRequestType) => {
        if (requestType === AccessRequestType.GrantAccess && config.makeRequestable) {
            for (const id of entitlements) {
                const entitlement = await isc.getEntitlement(id)
                if (!entitlement.requestable) {
                    await isc.patchEntitlement(id, [{ op: 'replace', path: '/requestable', value: true }])
                }
            }
        }
        const response = await isc.createAccessRequest(identity, entitlements, requestType, config.comment)
        return response
    }

    const stdTestConnection: StdTestConnectionHandler = async (context, input, res) => {
        try {
            await isc.getPublicIdentityConfig()
            res.send({})
        } catch (error) {
            logger.error(error)
            throw new ConnectorError(error as string)
        }
    }

    const stdEntitlementList: StdEntitlementListHandler = async (context, input, res) => {
        const entitlementSearch = (await isc.search(config.search, Index.Entitlements)) as EntitlementDocument[]

        for (const e of entitlementSearch) {
            const entitlement = new Entitlement(e)
            logger.debug(entitlement)
            res.send(entitlement)
        }
    }

    const stdAccountCreate: StdAccountCreateHandler = async (context, input, res) => {
        const name = input.attributes.name as string
        const entitlements = [input.attributes.entitlements].flat()

        const identity = await isc.getIdentityByName(name)

        if (!identity) {
            throw new ConnectorError('Identity not found')
        }

        const response = await createAccessRequest(identity.id, entitlements, AccessRequestType.GrantAccess)

        const account = new Account(identity, entitlements)
        logger.debug(account)
        res.send(account)
    }

    const stdAccountUpdate: StdAccountUpdateHandler = async (context, input, res) => {
        const identity = await isc.getIdentity(input.identity)
        const existingAccount = await isc.getAccount(input.identity)
        if (!identity) {
            throw new ConnectorError('Identity not found')
        }
        if (!existingAccount) {
            throw new ConnectorError('Account not found')
        }

        const entitlementsAdd: string[] = []
        const entitlementsRemove: string[] = []
        if (input.changes) {
            for (const change of input.changes) {
                const values = [change.value].flat()
                for (const value of values) {
                    switch (change.op) {
                        case 'Add':
                            entitlementsAdd.push(value)
                            break
                        case 'Remove':
                            entitlementsRemove.push(value)
                            break
                        case 'Set':
                            throw new ConnectorError('Set is not supported')
                    }
                }
            }
        }

        if (entitlementsAdd.length > 0) {
            const response = await createAccessRequest(identity.id, entitlementsAdd, AccessRequestType.GrantAccess)
        }

        if (entitlementsRemove.length > 0) {
            const response = await createAccessRequest(identity.id, entitlementsRemove, AccessRequestType.RevokeAccess)
        }

        const entitlements = [...existingAccount?.attributes?.entitlements, ...entitlementsAdd].filter(
            (x) => !entitlementsRemove.includes(x)
        )

        const account = new Account(identity, entitlements)
        logger.debug(account)
        res.send(account)
    }

    return createConnector()
        .stdTestConnection(stdTestConnection)
        .stdAccountCreate(stdAccountCreate)
        .stdAccountUpdate(stdAccountUpdate)
        .stdEntitlementList(stdEntitlementList)
}
