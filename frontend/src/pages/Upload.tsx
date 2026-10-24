import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, FileImage, FileText, Lightbulb, RotateCcw, Trash2, UploadCloud } from 'lucide-react'
import { useRef } from 'react'
import { useDropzone } from 'react-dropzone'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { PipelineSteps, StageLabel } from '@/components/medical'
import { Badge, Button, Card, CardHeader, ErrorNote, PageHeader } from '@/components/ui'
import { api } from '@/lib/api'
import { useActivePatient, useLang } from '@/lib/patient'
import type { DocumentInfo } from '@/lib/types'
import { cn, fmtDate } from '@/lib/utils'

const ACCEPT = {
  'application/pdf': ['.pdf'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/webp': ['.webp'],
  'image/tiff': ['.tif', '.tiff'],
  'image/bmp': ['.bmp'],
}

const isActive = (d: DocumentInfo) => d.status === 'queued' || d.status === 'processing'

export default function UploadPage() {
  const { t } = useTranslation()
  const patient = useActivePatient()
  const qc = useQueryClient()
  const camera = useRef<HTMLInputElement>(null)

  const docs = useQuery({
    queryKey: ['documents', patient.id],
    queryFn: () => api.documents(patient.id),
    refetchInterval: (q) => (q.state.data?.some(isActive) ? 1500 : false),
  })

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['documents', patient.id] })
    qc.invalidateQueries({ queryKey: ['profile', patient.id] })
    qc.invalidateQueries({ queryKey: ['timeline', patient.id] })
  }

  const upload = useMutation({
    mutationFn: (files: File[]) => api.upload(patient.id, files),
    onSettled: refreshAll,
  })
  const reprocess = useMutation({ mutationFn: api.reprocess, onSettled: refreshAll })
  const remove = useMutation({
    mutationFn: api.deleteDocument,
    onSettled: (_r, _e, id) => {
      qc.removeQueries({ queryKey: ['document', id] })
      qc.removeQueries({ queryKey: ['patientSummary', patient.id] })
      for (const k of ['trends', 'medications']) qc.invalidateQueries({ queryKey: [k, patient.id] })
      refreshAll()
    },
  })

  const { getRootProps, getInputProps, isDragActive, fileRejections, open } = useDropzone({
    accept: ACCEPT,
    maxSize: 25 * 1024 * 1024,
    onDrop: (files) => files.length && upload.mutate(files),
  })

  return (
    <div className="space-y-6">
      <PageHeader title={t('upload.title')} subtitle={t('upload.subtitle')} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <div
            {...getRootProps()}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed bg-white px-5 py-9 text-center transition-colors sm:px-6 sm:py-14',
              isDragActive ? 'border-brand-500 bg-brand-50' : 'border-slate-300 hover:border-brand-400 hover:bg-slate-50',
            )}
          >
            <input {...getInputProps()} />
            <div className="rounded-full bg-brand-50 p-4 text-brand-600">
              <UploadCloud className="h-8 w-8" />
            </div>
            <p className="mt-4 text-lg font-medium text-slate-900">{t('upload.drop')}</p>
            <p className="mt-1 text-sm text-slate-500">{t('upload.formats')}</p>
            <div
              className="mt-5 grid w-full max-w-xs grid-cols-1 gap-2.5 sm:flex sm:w-auto sm:max-w-none sm:flex-wrap sm:items-center sm:justify-center sm:gap-3"
              onClick={(e) => e.stopPropagation()}
            >
              <Button type="button" loading={upload.isPending} onClick={open}>
                <FileText className="h-4 w-4" />
                {upload.isPending ? t('upload.uploading') : t('upload.browse')}
              </Button>
              <span className="hidden text-sm text-slate-400 sm:inline">{t('upload.or')}</span>
              <Button type="button" variant="secondary" onClick={() => camera.current?.click()} disabled={upload.isPending}>
                <Camera className="h-4 w-4" />
                {t('upload.camera')}
              </Button>
              <input
                ref={camera}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => {
                  const f = Array.from(e.target.files ?? [])
                  if (f.length) upload.mutate(f)
                  e.target.value = ''
                }}
              />
            </div>
          </div>
          {upload.error && <ErrorNote error={upload.error} />}
          {reprocess.error && <ErrorNote error={reprocess.error} />}
          {remove.error && <ErrorNote error={remove.error} />}
          {fileRejections.length > 0 && (
            <ErrorNote
              error={fileRejections
                .map((r) => `${r.file.name}: ${r.errors.map((e) => t(`upload.reject.${e.code}`, { defaultValue: e.message })).join(', ')}`)
                .join(' · ')}
            />
          )}

          <Card>
            <CardHeader title={t('upload.queue_title')} />
            {docs.data && docs.data.length > 0 ? (
              <ul className="divide-y divide-slate-100">
                {docs.data.slice(0, 15).map((d) => (
                  <UploadRow
                    key={d.id}
                    d={d}
                    retrying={reprocess.isPending && reprocess.variables === d.id}
                    onRetry={() => reprocess.mutate(d.id)}
                    deleting={remove.isPending && remove.variables === d.id}
                    onDelete={() => window.confirm(t(d.status === 'confirmed' ? 'docview.delete_confirm' : 'upload.delete_confirm')) && remove.mutate(d.id)}
                  />
                ))}
              </ul>
            ) : (
              <p className="px-5 py-6 text-sm text-slate-500">{t('upload.queue_empty')}</p>
            )}
          </Card>
        </div>

        <Card className="h-fit p-5">
          <h3 className="flex items-center gap-2 font-semibold text-slate-900">
            <Lightbulb className="h-5 w-5 text-amber-500" />
            {t('upload.tips_title')}
          </h3>
          <ul className="mt-3 space-y-3 text-sm text-slate-600">
            {['tip1', 'tip2', 'tip3'].map((k, i) => (
              <li key={k} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">{i + 1}</span>
                {t(`upload.${k}`)}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}

function UploadRow({
  d,
  retrying,
  onRetry,
  deleting,
  onDelete,
}: {
  d: DocumentInfo
  retrying: boolean
  onRetry: () => void
  deleting: boolean
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const lang = useLang()
  const Icon = d.mime_type.startsWith('image/') ? FileImage : FileText
  const timing = d.pipeline_log
    .filter((l) => l.model)
    .map((l) => `${t(`upload.stage.${l.stage}`, { defaultValue: l.stage })} ${((l.ms ?? 0) / 1000).toFixed(1)}s`)
    .join(' · ')
  return (
    <li className="px-4 py-4 sm:px-5" data-doc={d.id}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="rounded-lg bg-slate-100 p-2 text-slate-500">
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="truncate font-medium text-slate-900">{d.title || d.filename}</p>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
              {d.doc_type && <Badge>{t(`doctype.${d.doc_type}`)}</Badge>}
              {d.handwritten && <Badge>{t('review.handwritten')}</Badge>}
              {d.languages.length > 0 && <Badge>{d.languages.join(' + ').toUpperCase()}</Badge>}
              {d.stats && (
                <span>
                  {t('review.items', { count: d.stats.items_total })}
                  {d.stats.needs_review > 0 && ` · ${t('review.needs_review', { count: d.stats.needs_review })}`}
                </span>
              )}
              <span>{fmtDate(d.created_at, lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {d.status === 'review' && (
            <Link to={`/documents/${d.id}/review`}>
              <Button size="sm">{t('upload.review_btn')}</Button>
            </Link>
          )}
          {d.status === 'confirmed' && (
            <Link to={`/documents/${d.id}`}>
              <Button size="sm" variant="secondary">
                {t('upload.view_btn')}
              </Button>
            </Link>
          )}
          {d.status === 'failed' && (
            <Button size="sm" variant="secondary" loading={retrying} onClick={onRetry}>
              <RotateCcw className="h-4 w-4" />
              {t('upload.retry_btn')}
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-slate-400 hover:bg-red-50 hover:text-red-600"
            title={t('common.delete')}
            aria-label={`${t('common.delete')}: ${d.title || d.filename}`}
            loading={deleting}
            onClick={onDelete}
          >
            {!deleting && <Trash2 className="h-4 w-4" />}
          </Button>
        </div>
      </div>
      {d.status !== 'confirmed' && (
        <div className="mt-3 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
          <div className="flex-1">
            <PipelineSteps stage={d.stage} status={d.status} />
          </div>
          <div className="shrink-0 sm:w-56 sm:text-right">
            <StageLabel stage={d.stage} status={d.status} />
          </div>
        </div>
      )}
      {d.status === 'failed' && d.error && <p className="mt-2 text-xs text-red-600">{t('upload.failed')}: {d.error.slice(0, 200)}</p>}
      {timing && d.status === 'review' && <p className="mt-1.5 text-xs text-slate-400">{timing}</p>}
    </li>
  )
}
