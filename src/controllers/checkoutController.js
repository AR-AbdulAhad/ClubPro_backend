import { APIContracts, APIControllers } from "authorizenet";

export const authorizePayment = async (req, res) => {
  const { opaqueData, amount, items } = req.body;

  const customerId = req.user.id;
  const email = req.user.email;

  if (!amount || !opaqueData || !items?.length) {
    return res.status(400).json({ success: false, message: "Invalid payload" });
  }

  const merchantAuth = new APIContracts.MerchantAuthenticationType();
  merchantAuth.setName(process.env.AUTH_NET_API_LOGIN);
  merchantAuth.setTransactionKey(process.env.AUTH_NET_TRANSACTION_KEY);

  const paymentType = new APIContracts.PaymentType();
  const opaque = new APIContracts.OpaqueDataType();
  opaque.setDataDescriptor(opaqueData.dataDescriptor);
  opaque.setDataValue(opaqueData.dataValue);
  paymentType.setOpaqueData(opaque);

  const transactionRequest = new APIContracts.TransactionRequestType();
  transactionRequest.setTransactionType(
    APIContracts.TransactionTypeEnum.AUTHCAPTURETRANSACTION
  );
  transactionRequest.setPayment(paymentType);
  transactionRequest.setAmount(amount);

  const request = new APIContracts.CreateTransactionRequest();
  request.setMerchantAuthentication(merchantAuth);
  request.setTransactionRequest(transactionRequest);

  const controller = new APIControllers.CreateTransactionController(
    request.getJSON()
  );

  controller.execute(async () => {
    const response = controller.getResponse();
    const result = new APIContracts.CreateTransactionResponse(response);

    if (
      result.getMessages().getResultCode() ===
      APIContracts.MessageTypeEnum.OK
    ) {
      const transactionId =
        result.getTransactionResponse().getTransId();

      try {
        // 🔥 STRIPE-EQUIVALENT ORDER + STOCK LOGIC
        await prisma.$transaction(async (tx) => {
          // 1️⃣ Create order
          const order = await tx.order.create({
            data: {
              customerId,
              email,
              status: "PAID",
              totalAmount: amount,
              transactionId,
              items: {
                create: items.map((item) => ({
                  productId: item.id,
                  quantity: item.qty,
                  priceAtOrder: item.price,
                })),
              },
            },
          });

          // 2️⃣ Decrement stock (consolidating quantities by product)
          const requestedQtyByProduct = {};
          for (const item of items) {
            const pId = Number(item.id);
            requestedQtyByProduct[pId] = (requestedQtyByProduct[pId] || 0) + item.qty;
          }

          for (const [pIdStr, totalQty] of Object.entries(requestedQtyByProduct)) {
            const pId = Number(pIdStr);
            const product = await tx.product.findUnique({
              where: { id: pId },
            });

            if (!product) {
              throw new Error(`Product ${pId} not found`);
            }

            if (product.stock < totalQty) {
              throw new Error(
                `Not enough stock for ${product.name}. Available: ${product.stock}, Requested: ${totalQty}`
              );
            }

            await tx.product.update({
              where: { id: pId },
              data: {
                stock: { decrement: totalQty },
              },
            });
          }

          console.log("Order created:", order.id);
        });

        res.json({
          success: true,
          transactionId,
        });

      } catch (dbError) {
        console.error("Order creation failed:", dbError);

        // OPTIONAL: auto-void transaction here if needed

        res.status(500).json({
          success: false,
          message: "Payment succeeded but order failed",
        });
      }

    } else {
      res.status(400).json({
        success: false,
        message:
          result
            .getTransactionResponse()
            ?.getErrors()
            ?.getError()?.[0]
            ?.getErrorText() ||
          result.getMessages().getMessage()[0].getText(),
      });
    }
  });
};



// export const authorizePayment = async (req, res) => {
//   const { opaqueData, amount,items } = req.body;


//   const customerId = req.user.id;
//   const email = req.user.email;

//   if (!amount || !opaqueData || !items?.length) {
//     return res.status(400).json({ success: false, message: "Invalid payload" });
//   }


//   const merchantAuth = new APIContracts.MerchantAuthenticationType();
//   merchantAuth.setName(process.env.AUTH_NET_API_LOGIN);
//   merchantAuth.setTransactionKey(process.env.AUTH_NET_TRANSACTION_KEY);

//   const paymentType = new APIContracts.PaymentType();
//   const opaque = new APIContracts.OpaqueDataType();
//   opaque.setDataDescriptor(opaqueData.dataDescriptor);
//   opaque.setDataValue(opaqueData.dataValue);
//   paymentType.setOpaqueData(opaque);

//   const transactionRequest = new APIContracts.TransactionRequestType();
//   transactionRequest.setTransactionType(
//     APIContracts.TransactionTypeEnum.AUTHCAPTURETRANSACTION
//   );
//   transactionRequest.setPayment(paymentType);
//   transactionRequest.setAmount(amount);

//   const request = new APIContracts.CreateTransactionRequest();
//   request.setMerchantAuthentication(merchantAuth);
//   request.setTransactionRequest(transactionRequest);

//   const controller = new APIControllers.CreateTransactionController(
//     request.getJSON()
//   );

//   controller.execute(() => {
//     const response = controller.getResponse();
//     const result = new APIContracts.CreateTransactionResponse(response);

//     if (
//       result.getMessages().getResultCode() ===
//       APIContracts.MessageTypeEnum.OK
//     ) {
//       res.json({ success: true });
//     } else {
//       res.status(400).json({
//         success: false,
//         message:
//           result.getTransactionResponse().getErrors().getError()[0].getErrorText(),
//       });
//     }
//   });
// };

// import { APIContracts, APIControllers } from "authorizenet";
// import { PrismaClient } from "@prisma/client";

// const prisma = new PrismaClient();

// export const authorizePayment = async (req, res) => {
//   const { amount, opaqueData, items } = req.body;

//   // 🔐 from JWT
//   const customerId = req.user.id;
//   const email = req.user.email;

//   if (!amount || !opaqueData || !items?.length) {
//     return res.status(400).json({ success: false, message: "Invalid payload" });
//   }

//   try {
//     /* =======================
//        1️⃣ AUTHORIZE.NET PAYMENT
//        ======================= */

//     const merchantAuth = new APIContracts.MerchantAuthenticationType();
//     merchantAuth.setName(process.env.AUTH_NET_API_LOGIN_ID);
//     merchantAuth.setTransactionKey(process.env.AUTH_NET_TRANSACTION_KEY);

//     const opaque = new APIContracts.OpaqueDataType();
//     opaque.setDataDescriptor(opaqueData.dataDescriptor);
//     opaque.setDataValue(opaqueData.dataValue);

//     const payment = new APIContracts.PaymentType();
//     payment.setOpaqueData(opaque);

//     const transactionRequest = new APIContracts.TransactionRequestType();
//     transactionRequest.setTransactionType(
//       APIContracts.TransactionTypeEnum.AUTHCAPTURETRANSACTION
//     );
//     transactionRequest.setAmount(amount);
//     transactionRequest.setPayment(payment);

//     const customer = new APIContracts.CustomerDataType();
//     customer.setId(customerId.toString());
//     customer.setEmail(email);
//     transactionRequest.setCustomer(customer);

//     const request = new APIContracts.CreateTransactionRequest();
//     request.setMerchantAuthentication(merchantAuth);
//     request.setTransactionRequest(transactionRequest);

//     const controller = new APIControllers.CreateTransactionController(
//       request.getJSON()
//     );

//     controller.execute(async () => {
//       const apiResponse = controller.getResponse();
//       const response = new APIContracts.CreateTransactionResponse(apiResponse);

//       if (response.getMessages().getResultCode() !== "Ok") {
//         return res.status(400).json({
//           success: false,
//           message: response.getMessages().getMessage()[0].getText(),
//         });
//       }

//       const transactionId =
//         response.getTransactionResponse().getTransId();

//       /* =======================
//          2️⃣ ORDER + STOCK (Stripe-equivalent)
//          ======================= */

//       await prisma.$transaction(async (tx) => {
//         const order = await tx.order.create({
//           data: {
//             customerId,
//             status: "PAID",
//             totalAmount: amount,
//             transactionId,
//             items: {
//               create: items.map(item => ({
//                 productId: item.id,
//                 quantity: item.qty,
//                 priceAtOrder: item.price,
//               })),
//             },
//           },
//         });

//         for (const item of items) {
//           const product = await tx.product.findUnique({
//             where: { id: item.id },
//           });

//           if (!product) {
//             throw new Error(`Product ${item.id} not found`);
//           }

//           if (product.stock < item.qty) {
//             throw new Error(`Insufficient stock for ${product.name}`);
//           }

//           await tx.product.update({
//             where: { id: item.id },
//             data: { stock: { decrement: item.qty } },
//           });
//         }

//         console.log("Order created:", order.id);
//       });

//       res.json({ success: true, transactionId });
//     });

//   } catch (err) {
//     console.error("Payment flow failed:", err);
//     res.status(500).json({
//       success: false,
//       message: "Payment failed",
//     });
//   }
// };
