import jwt from 'jsonwebtoken';
import set from 'lodash/set';
import { isHtmlRenderedContentType, sandboxHtmlResponse } from 'n8n-core';
import type {
	IDataObject,
	IExecuteFunctions,
	IN8nHttpFullResponse,
	IN8nHttpResponse,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import {
	jsonParse,
	NodeOperationError,
	NodeConnectionTypes,
	WEBHOOK_NODE_TYPE,
	FORM_TRIGGER_NODE_TYPE,
	CHAT_TRIGGER_NODE_TYPE,
	WAIT_NODE_TYPE,
	WAIT_INDEFINITELY,
} from 'n8n-workflow';
import type { Readable } from 'stream';

import { getBinaryResponse } from './utils/binary';
import { configuredOutputs } from './utils/outputs';
import { formatPrivateKey, generatePairedItemData } from '../../utils/utilities';

const respondWithProperty: INodeProperties = {
	displayName: 'Respond With',
	name: 'respondWith',
	type: 'options',
	options: [
		{
			name: 'All Incoming Items',
			value: 'allIncomingItems',
			description: 'Respond with all input JSON items',
		},
		{
			name: 'Binary File',
			value: 'binary',
			description: 'Respond with incoming file binary data',
		},
		{
			name: 'First Incoming Item',
			value: 'firstIncomingItem',
			description: 'Respond with the first input JSON item',
		},
		{
			name: 'JSON',
			value: 'json',
			description: 'Respond with a custom JSON body',
		},
		{
			name: 'JWT Token',
			value: 'jwt',
			description: 'Respond with a JWT token',
		},
		{
			name: 'No Data',
			value: 'noData',
			description: 'Respond with an empty body',
		},
		{
			name: 'Redirect',
			value: 'redirect',
			description: 'Respond with a redirect to a given URL',
		},
		{
			name: 'Text',
			value: 'text',
			description: 'Respond with a simple text message body',
		},
	],
	default: 'firstIncomingItem',
	description: 'The data that should be returned',
};

export class RespondToWebhook implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Respond to Webhook',
		icon: { light: 'file:webhook.svg', dark: 'file:webhook.dark.svg' },
		name: 'respondToWebhook',
		group: ['transform'],
		version: [1, 1.1, 1.2, 1.3, 1.4, 1.5],
		// Keep the default version at 1.4 until streaming is fully supported
		defaultVersion: 1.4,
		description: 'Returns data for Webhook',
		defaults: {
			name: 'Respond to Webhook',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: `={{(${configuredOutputs})($nodeVersion, $parameter)}}`,
		credentials: [
			{
				name: 'jwtAuth',
				required: true,
				displayOptions: {
					show: {
						respondWith: ['jwt'],
					},
				},
			},
		],
		properties: [
			{
				displayName: 'Enable Response Output Branch',
				name: 'enableResponseOutput',
				type: 'boolean',
				default: false,
				description:
					'Whether to provide an additional output branch with the response sent to the webhook',
				isNodeSetting: true,
				displayOptions: { show: { '@version': [{ _cnd: { gte: 1.4 } }] } },
			},
			{
				displayName:
					'Verify that the "Webhook" node\'s "Respond" parameter is set to "Using Respond to Webhook Node". <a href="https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.respondtowebhook/" target="_blank">More details',
				name: 'generalNotice',
				type: 'notice',
				default: '',
			},
			{
				...respondWithProperty,
				displayOptions: { show: { '@version': [1, 1.1] } },
			},
			{
				...respondWithProperty,
				noDataExpression: true,
				displayOptions: { show: { '@version': [{ _cnd: { gte: 1.2 } }] } },
			},
			{
				displayName: 'Credentials',
				name: 'credentials',
				type: 'credentials',
				default: '',
				displayOptions: {
					show: {
						respondWith: ['jwt'],
					},
				},
			},
			{
				displayName:
					'When using expressions, note that this node will only run for the first item in the input data',
				name: 'webhookNotice',
				type: 'notice',
				displayOptions: {
					show: {
						respondWith: ['json', 'text', 'jwt'],
					},
				},
				default: '',
			},
			{
				displayName: 'Redirect URL',
				name: 'redirectURL',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						respondWith: ['redirect'],
					},
				},
				default: '',
				placeholder: 'e.g. http://www.n8n.io',
				description: 'The URL to redirect to',
				validateType: 'url',
			},
			{
				displayName: 'Response Body',
				name: 'responseBody',
				type: 'json',
				displayOptions: {
					show: {
						respondWith: ['json'],
					},
				},
				default: '{\n  "myField": "value"\n}',
				typeOptions: {
					rows: 4,
				},
				description: 'The HTTP response JSON data',
			},
			{
				displayName: 'Payload',
				name: 'payload',
				type: 'json',
				displayOptions: {
					show: {
						respondWith: ['jwt'],
					},
				},
				default: '{\n  "myField": "value"\n}',
				typeOptions: {
					rows: 4,
				},
				validateType: 'object',
				description: 'The payload to include in the JWT token',
			},
			{
				displayName: 'Response Body',
				name: 'responseBody',
				type: 'string',
				displayOptions: {
					show: {
						respondWith: ['text'],
					},
				},
				typeOptions: {
					rows: 2,
				},
				default: '',
				placeholder: 'e.g. Workflow completed',
				description: 'The HTTP response text data',
			},
			{
				displayName: 'Response Data Source',
				name: 'responseDataSource',
				type: 'options',
				displayOptions: {
					show: {
						respondWith: ['binary'],
					},
				},
				options: [
					{
						name: 'Choose Automatically From Input',
						value: 'automatically',
						description: 'Use if input data will contain a single piece of binary data',
					},
					{
						name: 'Specify Myself',
						value: 'set',
						description: 'Enter the name of the input field the binary data will be in',
					},
				],
				default: 'automatically',
			},
			{
				displayName: 'Input Field Name',
				name: 'inputFieldName',
				type: 'string',
				required: true,
				default: 'data',
				displayOptions: {
					show: {
						respondWith: ['binary'],
						responseDataSource: ['set'],
					},
				},
				description: 'The name of the node input field with the binary data',
			},
			{
				displayName:
					'To avoid unexpected behavior, add a "Content-Type" response header with the appropriate value',
				name: 'contentTypeNotice',
				type: 'notice',
				default: '',
				displayOptions: {
					show: {
						respondWith: ['text'],
					},
				},
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				options: [
					{
						displayName: 'Response Code',
						name: 'responseCode',
						type: 'number',
						typeOptions: {
							minValue: 100,
							maxValue: 599,
						},
						default: 200,
						description: 'The HTTP response code to return. Defaults to 200.',
					},
					{
						displayName: 'Response Headers',
						name: 'responseHeaders',
						placeholder: 'Add Response Header',
						description: 'Add headers to the webhook response',
						type: 'fixedCollection',
						typeOptions: {
							multipleValues: true,
						},
						default: {},
						options: [
							{
								name: 'entries',
								displayName: 'Entries',
								values: [
									{
										displayName: 'Name',
										name: 'name',
										type: 'string',
										default: '',
										description: 'Name of the header',
									},
									{
										displayName: 'Value',
										name: 'value',
										type: 'string',
										default: '',
										description: 'Value of the header',
									},
								],
							},
						],
					},
					{
						displayName: 'Put Response in Field',
						name: 'responseKey',
						type: 'string',
						displayOptions: {
							show: {
								['/respondWith']: ['allIncomingItems', 'firstIncomingItem'],
							},
						},
						default: '',
						description: 'The name of the response field to put all items in',
						placeholder: 'e.g. data',
					},
					{
						displayName: 'Enable Streaming',
						name: 'enableStreaming',
						type: 'boolean',
						default: true,
						description: 'Whether to enable streaming to the response',
						displayOptions: {
							show: {
								['/respondWith']: ['allIncomingItems', 'firstIncomingItem', 'text', 'json', 'jwt'],
								'@version': [{ _cnd: { gte: 1.5 } }],
							},
						},
					},
				],
			},
		],
	};

	async onMessage(
		context: IExecuteFunctions,
		_data: INodeExecutionData,
	): Promise<INodeExecutionData[][]> {
		const inputData = context.getInputData();
		return [inputData];
	}

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const nodeVersion = this.getNode().typeVersion;

		const WEBHOOK_NODE_TYPES = [
			WEBHOOK_NODE_TYPE,
			FORM_TRIGGER_NODE_TYPE,
			CHAT_TRIGGER_NODE_TYPE,
			WAIT_NODE_TYPE,
		];

		let response: IN8nHttpFullResponse;

		const connectedNodes = this.getParentNodes(this.getNode().name, {
			includeNodeParameters: true,
		});

		const options = this.getNodeParameter('options', 0, {});

		const shouldStream =
			nodeVersion >= 1.5 && this.isStreaming() && options.enableStreaming !== false;

		try {
			if (nodeVersion >= 1.1) {
				if (!connectedNodes.some(({ type }) => WEBHOOK_NODE_TYPES.includes(type))) {
					throw new NodeOperationError(
						this.getNode(),
						new Error('No Webhook node found in the workflow'),
						{
							description:
								'Insert a Webhook node to your workflow and set the “Respond” parameter to “Using Respond to Webhook Node” ',
						},
					);
				}
			}

			const respondWith = this.getNodeParameter('respondWith', 0) as string;

			const headers = {} as IDataObject;
			if (options.responseHeaders) {
				for (const header of (options.responseHeaders as IDataObject).entries as IDataObject[]) {
					if (typeof header.name !== 'string') {
						header.name = header.name?.toString();
					}
					headers[header.name?.toLowerCase() as string] = header.value?.toString();
				}
			}

			const hasHtmlContentType =
				headers['content-type'] && isHtmlRenderedContentType(headers['content-type'] as string);

			let statusCode = (options.responseCode as number) || 200;
			let responseBody: IN8nHttpResponse | Readable;
			if (respondWith === 'json') {
				const responseBodyParameter = this.getNodeParameter('responseBody', 0) as string;
				if (responseBodyParameter) {
					if (typeof responseBodyParameter === 'object') {
						responseBody = responseBodyParameter;
					} else {
						try {
							responseBody = jsonParse(responseBodyParameter);
						} catch (error) {
							throw new NodeOperationError(this.getNode(), error as Error, {
								message: "Invalid JSON in 'Response Body' field",
								description:
									"Check that the syntax of the JSON in the 'Response Body' parameter is valid",
							});
						}
					}
				}

				if (shouldStream) {
					this.sendChunk('begin', 0);
					this.sendChunk('item', 0, responseBody as IDataObject);
					this.sendChunk('end', 0);
				}
			} else if (respondWith === 'jwt') {
				try {
					const { keyType, secret, algorithm, privateKey } = await this.getCredentials<{
						keyType: 'passphrase' | 'pemKey';
						privateKey: string;
						secret: string;
						algorithm: jwt.Algorithm;
					}>('jwtAuth');

					let secretOrPrivateKey;

					if (keyType === 'passphrase') {
						secretOrPrivateKey = secret;
					} else {
						secretOrPrivateKey = formatPrivateKey(privateKey);
					}
					const payload = this.getNodeParameter('payload', 0, {}) as IDataObject;
					const token = jwt.sign(payload, secretOrPrivateKey, { algorithm });
					responseBody = { token };

					if (shouldStream) {
						this.sendChunk('begin', 0);
						this.sendChunk('item', 0, responseBody as IDataObject);
						this.sendChunk('end', 0);
					}
				} catch (error) {
					throw new NodeOperationError(this.getNode(), error as Error, {
						message: 'Error signing JWT token',
					});
				}
			} else if (respondWith === 'allIncomingItems') {
				const respondItems = items.map((item, index) => {
					this.sendChunk('begin', index);
					this.sendChunk('item', index, item.json);
					this.sendChunk('end', index);
					return item.json;
				});
				responseBody = options.responseKey
					? set({}, options.responseKey as string, respondItems)
					: respondItems;
			} else if (respondWith === 'firstIncomingItem') {
				responseBody = options.responseKey
					? set({}, options.responseKey as string, items[0].json)
					: items[0].json;
				if (shouldStream) {
					this.sendChunk('begin', 0);
					this.sendChunk('item', 0, items[0].json);
					this.sendChunk('end', 0);
				}
			} else if (respondWith === 'text') {
				// If a user doesn't set the content-type header and uses html, the html can still be rendered on the browser
				const rawBody = this.getNodeParameter('responseBody', 0) as string;
				if (hasHtmlContentType || !headers['content-type']) {
					responseBody = sandboxHtmlResponse(rawBody);
				} else {
					responseBody = rawBody;
				}
				// Send the raw body to the stream
				if (shouldStream) {
					this.sendChunk('begin', 0);
					this.sendChunk('item', 0, rawBody);
					this.sendChunk('end', 0);
				}
			} else if (respondWith === 'binary') {
				const item = items[0];

				if (item.binary === undefined) {
					throw new NodeOperationError(this.getNode(), 'No binary data exists on the first item!');
				}

				let responseBinaryPropertyName: string;

				const responseDataSource = this.getNodeParameter('responseDataSource', 0) as string;

				if (responseDataSource === 'set') {
					responseBinaryPropertyName = this.getNodeParameter('inputFieldName', 0) as string;
				} else {
					const binaryKeys = Object.keys(item.binary);
					if (binaryKeys.length === 0) {
						throw new NodeOperationError(
							this.getNode(),
							'No binary data exists on the first item!',
						);
					}
					responseBinaryPropertyName = binaryKeys[0];
				}

				const binaryData = this.helpers.assertBinaryData(0, responseBinaryPropertyName);

				responseBody = getBinaryResponse(binaryData, headers);
			} else if (respondWith === 'redirect') {
				headers.location = this.getNodeParameter('redirectURL', 0) as string;
				statusCode = (options.responseCode as number) ?? 307;
			} else if (respondWith !== 'noData') {
				throw new NodeOperationError(
					this.getNode(),
					`The Response Data option "${respondWith}" is not supported!`,
				);
			}

			const chatTrigger = connectedNodes.find(
				(node) => node.type === CHAT_TRIGGER_NODE_TYPE && !node.disabled,
			);

			const parameters = chatTrigger?.parameters as {
				options: { responseMode: string };
			};

			// if workflow is started from chat trigger and responseMode is set to "responseNodes"
			// response to chat will be send by ChatService
			if (
				chatTrigger &&
				!chatTrigger.disabled &&
				parameters.options.responseMode === 'responseNodes'
			) {
				let message = '';

				if (responseBody && typeof responseBody === 'object' && !Array.isArray(responseBody)) {
					message =
						(((responseBody as IDataObject).output ??
							(responseBody as IDataObject).text ??
							(responseBody as IDataObject).message) as string) ?? '';

					if (message === '' && Object.keys(responseBody).length > 0) {
						try {
							message = JSON.stringify(responseBody, null, 2);
						} catch (e) {}
					}
				}

				await this.putExecutionToWait(WAIT_INDEFINITELY);
				return [[{ json: {}, sendMessage: message }]];
			}

			if (
				hasHtmlContentType &&
				respondWith !== 'text' &&
				respondWith !== 'binary' &&
				responseBody
			) {
				responseBody = sandboxHtmlResponse(JSON.stringify(responseBody as string));
			}

			response = {
				body: responseBody,
				headers,
				statusCode,
			};

			if (!shouldStream || respondWith === 'binary') {
				this.sendResponse(response);
			}
		} catch (error) {
			if (this.continueOnFail()) {
				const itemData = generatePairedItemData(items.length);
				const returnData = this.helpers.constructExecutionMetaData(
					[{ json: { error: error.message } }],
					{ itemData },
				);
				return [returnData];
			}

			throw error;
		}

		if (nodeVersion === 1.3) {
			return [items, [{ json: { response } }]];
		} else if (nodeVersion >= 1.4 && this.getNodeParameter('enableResponseOutput', 0, false)) {
			return [items, [{ json: { response } }]];
		}

		return [items];
	}
}
