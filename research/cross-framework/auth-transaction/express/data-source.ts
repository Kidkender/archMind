import { DataSource } from 'typeorm'

export const dataSource = new DataSource({ type: 'postgres' })
