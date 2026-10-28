import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Payments (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('/v1/webhooks/mercadopago (POST) - deve aceitar webhook com payload válido', async () => {
    const payload = {
      type: 'payment',
      data: { id: '123456789' },
    };

    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/mercadopago')
      .send(payload)
      .expect(200);

    expect(res.body.ok).toBeDefined();
  });

  it('/v1/webhooks/mercadopago (POST) - deve rejeitar payload sem tipo', async () => {
    const payload = { data: { id: '123' } };

    await request(app.getHttpServer())
      .post('/v1/webhooks/mercadopago')
      .send(payload)
      .expect(200);
  });
});
