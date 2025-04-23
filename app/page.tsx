'use client'
import { useState, FormEvent } from 'react'

interface FormData {
  name: string
  password: string
  usageType: 'personal' | 'project' | ''
  storageQuota: number | ''
}

const Home: React.FC = () => {
  const [form, setForm] = useState<FormData>({ name: '', password: '', usageType: '', storageQuota: '' })
  const [status, setStatus] = useState<'idle'|'loading'|'success'|'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string>('')

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target
    const processedValue = type === 'number' ? (value === '' ? '' : parseFloat(value)) : value
    setForm({ ...form, [name]: processedValue })
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setStatus('loading')
    setErrorMsg('')

    if (!form.name || !form.password || !form.usageType || form.storageQuota === '') {
      setErrorMsg('すべての項目を入力してください。')
      setStatus('error')
      return
    }
    if (form.storageQuota <= 0) {
      setErrorMsg('ストレージ使用量は正の値を入力してください。')
      setStatus('error')
      return
    }

    try {
      const response = await fetch('/api/truenas', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(form),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.message || 'API request failed')
      }

      setStatus('success')
      setForm({ name: '', password: '', usageType: '', storageQuota: '' })

    } catch (error) {
      console.error('Submission failed:', error)
      setErrorMsg(error instanceof Error ? error.message : '申請に失敗しました。')
      setStatus('error')
    }
  }

  return (
    <div className="max-w-lg mx-auto my-8 p-8 border border-gray-300 rounded-lg shadow-md">
      <h1 className="text-2xl font-bold text-center mb-8">NASサーバー申請フォーム</h1>
      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-gray-700">学籍番号</label>
          <input
            type="text"
            id="name"
            name="name"
            value={form.name}
            onChange={handleChange}
            required
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
          />
        </div>
        <div>
          <label htmlFor="password" className="block text-sm font-medium text-gray-700">パスワード</label>
          <input
            type="password"
            id="password"
            name="password"
            value={form.password}
            onChange={handleChange}
            required
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
          />
        </div>
        <div>
          <label htmlFor="usageType" className="block text-sm font-medium text-gray-700">利用形態</label>
          <select
            id="usageType"
            name="usageType"
            value={form.usageType}
            onChange={handleChange}
            required
            className="mt-1 block w-full px-3 py-2 border border-gray-300 bg-white rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
          >
            <option value="" disabled>選択してください</option>
            <option value="personal">個人</option>
            <option value="project">プロジェクト</option>
          </select>
        </div>
        <div>
          <label htmlFor="storageQuota" className="block text-sm font-medium text-gray-700">希望ストレージ容量 (GB)</label>
          <input
            type="number"
            id="storageQuota"
            name="storageQuota"
            value={form.storageQuota}
            onChange={handleChange}
            required
            min="1"
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={status === 'loading'}
          className={`w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white ${
            status === 'loading'
              ? 'bg-gray-400 cursor-not-allowed'
              : 'bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500'
          }`}
        >
          {status === 'loading' ? '申請中...' : '申請'}
        </button>
      </form>
      {status === 'success' && <p className="mt-4 text-center text-green-600">申請リクエストを受け付けました。</p>}
      {status === 'error' && <p className="mt-4 text-center text-red-600">{errorMsg || '申請に失敗しました。'}</p>}
    </div>
  )
}

export default Home