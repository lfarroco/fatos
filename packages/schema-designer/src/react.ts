import * as React from 'react';
import {
	createEmptySchemaDesignerDocument,
	exportSchemaDesignerDocument,
	importSchemaDesignerDocument,
	type Cardinality,
	type SchemaDesignerDocument,
	type ValueType
} from './index';
import {
	addAttribute,
	addEntity,
	addRelationship,
	moveEntity,
	renameEntity,
	updateAttribute,
	updateRelationshipName
} from './editor';

export type SchemaDesignerWorkspaceProps = {
	initialDocument?: SchemaDesignerDocument;
	onDocumentChange?: (document: SchemaDesignerDocument) => void;
};

type DragState = {
	entityId: string;
	offsetX: number;
	offsetY: number;
} | null;

type ConnectDraft = {
	name: string;
	fromEntityId: string;
	toEntityId: string;
	fromCardinality: Cardinality;
	toCardinality: Cardinality;
	referenceAttributeName: string;
};

const rootStyle: React.CSSProperties = {
	display: 'grid',
	gridTemplateColumns: '240px minmax(480px, 1fr) 320px',
	minHeight: '560px',
	border: '1px solid #0f172a',
	borderRadius: '12px',
	overflow: 'hidden',
	fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
	color: '#0f172a',
	background: 'linear-gradient(120deg, #e0f2fe 0%, #f8fafc 60%, #cffafe 100%)'
};

const panelStyle: React.CSSProperties = {
	padding: '12px',
	borderRight: '1px solid #cbd5e1',
	background: 'rgba(248, 250, 252, 0.85)'
};

const rightPanelStyle: React.CSSProperties = {
	padding: '12px',
	borderLeft: '1px solid #cbd5e1',
	background: 'rgba(248, 250, 252, 0.9)',
	display: 'flex',
	flexDirection: 'column',
	gap: '10px'
};

const canvasStyle: React.CSSProperties = {
	position: 'relative',
	overflow: 'auto',
	backgroundImage:
		'radial-gradient(circle at 1px 1px, rgba(15, 23, 42, 0.25) 1px, transparent 0)',
	backgroundSize: '22px 22px'
};

const canvasInnerStyle: React.CSSProperties = {
	position: 'relative',
	minWidth: '1300px',
	minHeight: '760px'
};

const buttonStyle: React.CSSProperties = {
	border: '1px solid #0f172a',
	background: '#0f172a',
	color: '#f8fafc',
	padding: '6px 10px',
	borderRadius: '8px',
	cursor: 'pointer',
	fontSize: '12px'
};

const inputStyle: React.CSSProperties = {
	width: '100%',
	padding: '6px 8px',
	border: '1px solid #94a3b8',
	borderRadius: '6px',
	fontSize: '12px',
	background: '#ffffff'
};

function defaultConnectDraft(): ConnectDraft {
	return {
		name: '',
		fromEntityId: '',
		toEntityId: '',
		fromCardinality: 'one',
		toCardinality: 'many',
		referenceAttributeName: ''
	};
}

function withEntityDefaults(document: SchemaDesignerDocument): ConnectDraft {
	const first = document.schema.entities[0]?.id ?? '';
	const second = document.schema.entities[1]?.id ?? first;
	return {
		...defaultConnectDraft(),
		fromEntityId: first,
		toEntityId: second
	};
}

export function SchemaDesignerWorkspace(props: SchemaDesignerWorkspaceProps): React.ReactElement {
	const [document, setDocument] = React.useState<SchemaDesignerDocument>(
		props.initialDocument ?? createEmptySchemaDesignerDocument('Schema Designer')
	);
	const [dragState, setDragState] = React.useState<DragState>(null);
	const [connectDraft, setConnectDraft] = React.useState<ConnectDraft>(() => withEntityDefaults(document));
	const [jsonText, setJsonText] = React.useState('');
	const [jsonError, setJsonError] = React.useState('');
	const [selectedEntityId, setSelectedEntityId] = React.useState<string>('');
	const canvasRef = React.useRef<HTMLDivElement | null>(null);

	const updateDocument = React.useCallback(
		(nextDocument: SchemaDesignerDocument) => {
			setDocument(nextDocument);
			props.onDocumentChange?.(nextDocument);
		},
		[props]
	);

	React.useEffect(() => {
		setConnectDraft((current) => {
			if (current.fromEntityId !== '' && current.toEntityId !== '') {
				return current;
			}

			return withEntityDefaults(document);
		});
	}, [document]);

	const entityById = React.useMemo(
		() => new Map(document.schema.entities.map((entity) => [entity.id, entity])),
		[document]
	);

	const selectedEntity = selectedEntityId ? entityById.get(selectedEntityId) ?? null : null;

	const relationshipLayouts = React.useMemo(() => {
		return document.schema.relationships.map((relationship, index) => {
			const fromEntity = entityById.get(relationship.fromEntityId);
			const toEntity = entityById.get(relationship.toEntityId);

			if (!fromEntity || !toEntity) {
				const startX = 24;
				const startY = 24 + index * 22;
				const endX = 200;
				const endY = 24 + index * 22;
				const bendX = 112;
				return {
					relationship,
					startX,
					startY,
					endX,
					endY,
					bendX,
					labelX: bendX + 6,
					labelY: startY - 16
				};
			}

			const startX = fromEntity.position.x + 230;
			const startY = fromEntity.position.y + 30;
			const endX = toEntity.position.x;
			const endY = toEntity.position.y + 30;
			const bendOffset = ((index % 3) - 1) * 18;
			const bendX = startX + (endX - startX) / 2 + bendOffset;
			const labelX = bendX + 6;
			const labelY = (startY + endY) / 2 - 16;

			return {
				relationship,
				startX,
				startY,
				endX,
				endY,
				bendX,
				labelX,
				labelY
			};
		});
	}, [document.schema.relationships, entityById]);

	const onCanvasMouseMove = React.useCallback(
		(event: React.MouseEvent<HTMLDivElement>) => {
			if (!dragState || !canvasRef.current) {
				return;
			}

			const rect = canvasRef.current.getBoundingClientRect();
			const nextX = event.clientX - rect.left - dragState.offsetX + canvasRef.current.scrollLeft;
			const nextY = event.clientY - rect.top - dragState.offsetY + canvasRef.current.scrollTop;
			updateDocument(moveEntity(document, dragState.entityId, { x: Math.max(0, nextX), y: Math.max(0, nextY) }));
		},
		[document, dragState, updateDocument]
	);

	const onCanvasMouseUp = React.useCallback(() => {
		setDragState(null);
	}, []);

	const onEntityMouseDown = React.useCallback(
		(entityId: string) => (event: React.MouseEvent<HTMLDivElement>) => {
			const box = event.currentTarget.getBoundingClientRect();
			setSelectedEntityId(entityId);
			setDragState({
				entityId,
				offsetX: event.clientX - box.left,
				offsetY: event.clientY - box.top
			});
		},
		[]
	);

	const onCreateEntity = React.useCallback(() => {
		const created = addEntity(document);
		updateDocument(created.document);
		setSelectedEntityId(created.entityId);
	}, [document, updateDocument]);

	const onCreateRelationship = React.useCallback(() => {
		if (!connectDraft.fromEntityId || !connectDraft.toEntityId) {
			return;
		}

		const nextDocument = addRelationship(document, {
			name: connectDraft.name,
			fromEntityId: connectDraft.fromEntityId,
			toEntityId: connectDraft.toEntityId,
			fromCardinality: connectDraft.fromCardinality,
			toCardinality: connectDraft.toCardinality,
			referenceAttributeName: connectDraft.referenceAttributeName
		});
		updateDocument(nextDocument);
	}, [connectDraft, document, updateDocument]);

	const onAddAttribute = React.useCallback(() => {
		if (!selectedEntity) {
			return;
		}

		const nextDocument = addAttribute(document, {
			entityId: selectedEntity.id,
			name: `attribute_${selectedEntity.attributes.length + 1}`,
			valueType: 'string',
			cardinality: 'one'
		});
		updateDocument(nextDocument);
	}, [document, selectedEntity, updateDocument]);

	const onFromEntityChange = React.useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
		const value = event.currentTarget.value;
		setConnectDraft((current) => ({
			...current,
			fromEntityId: value
		}));
	}, []);

	const onToEntityChange = React.useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
		const value = event.currentTarget.value;
		setConnectDraft((current) => ({
			...current,
			toEntityId: value
		}));
	}, []);

	const onFromCardinalityChange = React.useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
		const value = event.currentTarget.value as Cardinality;
		setConnectDraft((current) => ({
			...current,
			fromCardinality: value
		}));
	}, []);

	const onToCardinalityChange = React.useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
		const value = event.currentTarget.value as Cardinality;
		setConnectDraft((current) => ({
			...current,
			toCardinality: value
		}));
	}, []);

	const onJsonTextChange = React.useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
		setJsonText(event.currentTarget.value);
	}, []);

	const onSelectedEntityNameChange = React.useCallback(
		(selectedId: string) => (event: React.ChangeEvent<HTMLInputElement>) => {
			updateDocument(renameEntity(document, selectedId, event.currentTarget.value));
		},
		[document, updateDocument]
	);

	const onRelationshipNameChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
		const value = event.currentTarget.value;
		setConnectDraft((current) => ({
			...current,
			name: value
		}));
	}, []);

	const onReferenceAttributeChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
		const value = event.currentTarget.value;
		setConnectDraft((current) => ({
			...current,
			referenceAttributeName: value
		}));
	}, []);

	const onAttributeNameChange = React.useCallback(
		(entityId: string, attributeId: string) => (event: React.ChangeEvent<HTMLInputElement>) => {
			const value = event.currentTarget.value;
			updateDocument(
				updateAttribute(document, {
					entityId,
					attributeId,
					name: value
				})
			);
		},
		[document, updateDocument]
	);

	const onAttributeValueTypeChange = React.useCallback(
		(entityId: string, attributeId: string) => (event: React.ChangeEvent<HTMLSelectElement>) => {
			const value = event.currentTarget.value as ValueType;
			updateDocument(
				updateAttribute(document, {
					entityId,
					attributeId,
					valueType: value
				})
			);
		},
		[document, updateDocument]
	);

	const onAttributeCardinalityChange = React.useCallback(
		(entityId: string, attributeId: string) => (event: React.ChangeEvent<HTMLSelectElement>) => {
			const value = event.currentTarget.value as Cardinality;
			updateDocument(
				updateAttribute(document, {
					entityId,
					attributeId,
					cardinality: value
				})
			);
		},
		[document, updateDocument]
	);

	const onExistingRelationshipNameChange = React.useCallback(
		(relationshipId: string) => (event: React.ChangeEvent<HTMLInputElement>) => {
			const value = event.currentTarget.value;
			updateDocument(updateRelationshipName(document, relationshipId, value));
		},
		[document, updateDocument]
	);

	return React.createElement(
		'div',
		{ style: rootStyle },
		React.createElement(
			'aside',
			{ style: panelStyle },
			React.createElement('h3', { style: { margin: '0 0 10px 0', fontSize: '14px' } }, document.schema.name),
			React.createElement('button', { type: 'button', onClick: onCreateEntity, style: buttonStyle }, 'Add Entity'),
			React.createElement(
				'div',
				{ style: { marginTop: '12px', display: 'grid', gap: '8px' } },
				document.schema.entities.map((entity) =>
					React.createElement(
						'button',
						{
							key: entity.id,
							type: 'button',
							onClick: () => setSelectedEntityId(entity.id),
							style: {
								...buttonStyle,
								textAlign: 'left',
								background: selectedEntityId === entity.id ? '#0f766e' : '#0f172a'
							}
						},
						`${entity.name} (${entity.attributes.length})`
					)
				)
			),
			selectedEntity
				? React.createElement(
					'div',
					{ style: { marginTop: '14px', display: 'grid', gap: '8px' } },
					React.createElement('label', { style: { fontSize: '12px' } }, 'Selected Entity Name'),
					React.createElement('input', {
						style: inputStyle,
						value: selectedEntity.name,
						onChange: onSelectedEntityNameChange(selectedEntity.id)
					}),
					React.createElement('button', { type: 'button', style: buttonStyle, onClick: onAddAttribute }, 'Add Attribute'),
					React.createElement(
						'div',
						{ style: { display: 'grid', gap: '8px' } },
						selectedEntity.attributes.map((attribute) =>
							React.createElement(
								'div',
								{
									key: attribute.id,
									style: {
										padding: '8px',
										border: '1px solid #cbd5e1',
										borderRadius: '8px',
										background: '#f8fafc',
										display: 'grid',
										gap: '6px'
									}
								},
								React.createElement('input', {
									style: inputStyle,
									value: attribute.name,
									onChange: onAttributeNameChange(selectedEntity.id, attribute.id)
								}),
								React.createElement(
									'div',
									{ style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' } },
									React.createElement(
										'select',
										{
											style: inputStyle,
											value: attribute.valueType,
											onChange: onAttributeValueTypeChange(selectedEntity.id, attribute.id)
										},
										React.createElement('option', { value: 'string' }, 'string'),
										React.createElement('option', { value: 'number' }, 'number'),
										React.createElement('option', { value: 'boolean' }, 'boolean'),
										React.createElement('option', { value: 'null' }, 'null'),
										React.createElement('option', { value: 'unknown' }, 'unknown')
									),
									React.createElement(
										'select',
										{
											style: inputStyle,
											value: attribute.cardinality,
											onChange: onAttributeCardinalityChange(selectedEntity.id, attribute.id)
										},
										React.createElement('option', { value: 'one' }, 'one'),
										React.createElement('option', { value: 'many' }, 'many')
									)
								)
							)
						)
					)
				)
				: null
		),
		React.createElement(
			'section',
			{
				ref: canvasRef,
				style: canvasStyle,
				onMouseMove: onCanvasMouseMove,
				onMouseUp: onCanvasMouseUp,
				onMouseLeave: onCanvasMouseUp
			},
			React.createElement(
				'div',
				{ style: canvasInnerStyle },
				React.createElement(
					'svg',
					{
						style: {
							position: 'absolute',
							inset: 0,
							width: '100%',
							height: '100%',
							pointerEvents: 'none'
						}
					},
					relationshipLayouts.map((layout) =>
						React.createElement(
							'g',
							{ key: `line-${layout.relationship.id}` },
							React.createElement('path', {
								d: `M ${layout.startX} ${layout.startY} L ${layout.bendX} ${layout.startY} L ${layout.bendX} ${layout.endY} L ${layout.endX} ${layout.endY}`,
								stroke: '#0f766e',
								strokeWidth: 2,
								strokeDasharray: '4 4',
								strokeLinejoin: 'round',
								fill: 'none'
							}),
							React.createElement('circle', {
								cx: layout.startX,
								cy: layout.startY,
								r: 3,
								fill: '#0f766e'
							}),
							React.createElement('circle', {
								cx: layout.endX,
								cy: layout.endY,
								r: 3,
								fill: '#0f766e'
							})
						)
					)
				),
				relationshipLayouts.map((layout) =>
					React.createElement(
						'div',
						{
							key: layout.relationship.id,
							style: {
								position: 'absolute',
								top: `${layout.labelY}px`,
								left: `${layout.labelX}px`,
								fontSize: '11px',
								padding: '2px 6px',
								borderRadius: '999px',
								border: '1px solid #155e75',
								background: '#cffafe',
								boxShadow: '0 1px 2px rgba(15, 23, 42, 0.2)'
							}
						},
						`${layout.relationship.name}: ${layout.relationship.fromCardinality} -> ${layout.relationship.toCardinality}`
					)
				),
				document.schema.entities.map((entity) =>
					React.createElement(
						'div',
						{
							key: entity.id,
							style: {
								position: 'absolute',
								left: `${entity.position.x}px`,
								top: `${entity.position.y}px`,
								width: '230px',
								border: selectedEntityId === entity.id ? '2px solid #0f766e' : '1px solid #0f172a',
								borderRadius: '10px',
								background: '#f8fafc',
								boxShadow: '0 6px 18px rgba(15, 23, 42, 0.18)',
								cursor: 'move'
							},
							onMouseDown: onEntityMouseDown(entity.id)
						},
						React.createElement(
							'div',
							{
								style: {
									padding: '8px 10px',
									background: 'linear-gradient(90deg, #164e63, #0f766e)',
									color: '#f0fdfa',
									borderTopLeftRadius: '8px',
									borderTopRightRadius: '8px',
									fontWeight: 700,
									fontSize: '12px'
								}
							},
							entity.name
						),
						React.createElement(
							'ul',
							{ style: { listStyle: 'none', margin: 0, padding: '8px 10px', fontSize: '11px', display: 'grid', gap: '5px' } },
							entity.attributes.length === 0
								? React.createElement('li', { style: { opacity: 0.7 } }, 'No attributes yet')
								: entity.attributes.map((attribute) => {
									return React.createElement(
										'li',
										{ key: attribute.id },
										`${attribute.name}: ${attribute.valueType} (${attribute.cardinality})`
									);
								})
						)
					)
				)
			)
		),
		React.createElement(
			'aside',
			{ style: rightPanelStyle },
			React.createElement('h4', { style: { margin: 0, fontSize: '13px' } }, 'Relationships'),
			React.createElement('input', {
				style: inputStyle,
				placeholder: 'Relationship name',
				value: connectDraft.name,
				onChange: onRelationshipNameChange
			}),
			React.createElement(
				'select',
				{
					style: inputStyle,
					value: connectDraft.fromEntityId,
					onChange: onFromEntityChange
				},
				document.schema.entities.map((entity) =>
					React.createElement('option', { key: `from-${entity.id}`, value: entity.id }, `From ${entity.name}`)
				)
			),
			React.createElement(
				'select',
				{
					style: inputStyle,
					value: connectDraft.toEntityId,
					onChange: onToEntityChange
				},
				document.schema.entities.map((entity) =>
					React.createElement('option', { key: `to-${entity.id}`, value: entity.id }, `To ${entity.name}`)
				)
			),
			React.createElement(
				'div',
				{ style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
				React.createElement(
					'select',
					{
						style: inputStyle,
						value: connectDraft.fromCardinality,
						onChange: onFromCardinalityChange
					},
					React.createElement('option', { value: 'one' }, 'from one'),
					React.createElement('option', { value: 'many' }, 'from many')
				),
				React.createElement(
					'select',
					{
						style: inputStyle,
						value: connectDraft.toCardinality,
						onChange: onToCardinalityChange
					},
					React.createElement('option', { value: 'one' }, 'to one'),
					React.createElement('option', { value: 'many' }, 'to many')
				)
			),
			React.createElement('input', {
				style: inputStyle,
				placeholder: 'Reference attribute (optional)',
				value: connectDraft.referenceAttributeName,
				onChange: onReferenceAttributeChange
			}),
			React.createElement('button', { type: 'button', style: buttonStyle, onClick: onCreateRelationship }, 'Connect'),
			React.createElement(
				'div',
				{ style: { display: 'grid', gap: '8px' } },
				document.schema.relationships.map((relationship) =>
					React.createElement(
						'div',
						{
							key: relationship.id,
							style: {
								padding: '8px',
								border: '1px solid #cbd5e1',
								borderRadius: '8px',
								background: '#f8fafc',
								display: 'grid',
								gap: '6px'
							}
						},
						React.createElement('input', {
							style: inputStyle,
							value: relationship.name,
							onChange: onExistingRelationshipNameChange(relationship.id)
						}),
						React.createElement(
							'div',
							{ style: { fontSize: '11px', color: '#334155' } },
							`${relationship.fromCardinality} ${relationship.fromEntityId} -> ${relationship.toCardinality} ${relationship.toEntityId}`
						)
					)
				)
			),
			React.createElement('hr', { style: { width: '100%', border: 0, borderTop: '1px solid #cbd5e1' } }),
			React.createElement('h4', { style: { margin: 0, fontSize: '13px' } }, 'Import / Export JSON'),
			React.createElement('button', {
				type: 'button',
				style: buttonStyle,
				onClick: () => {
					setJsonText(exportSchemaDesignerDocument(document));
					setJsonError('');
				}
			}, 'Generate JSON'),
			React.createElement('button', {
				type: 'button',
				style: buttonStyle,
				onClick: () => {
					try {
						const parsed = importSchemaDesignerDocument(jsonText);
						updateDocument(parsed);
						setJsonError('');
					} catch (error) {
						const message = error instanceof Error ? error.message : 'Failed to import JSON';
						setJsonError(message);
					}
				}
			}, 'Load JSON'),
			React.createElement('textarea', {
				style: {
					...inputStyle,
					minHeight: '220px',
					fontFamily: 'inherit',
					resize: 'vertical'
				},
				value: jsonText,
				onChange: onJsonTextChange
			}),
			jsonError
				? React.createElement('div', { style: { color: '#b91c1c', fontSize: '12px' } }, jsonError)
				: null
		)
	);
}
